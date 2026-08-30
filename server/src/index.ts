import { existsSync } from "node:fs";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { registerAuthRoutes } from "./auth/routes.js";
import { seedCredentialsFromEnv } from "./auth/credentials.js";
import { createAuthMiddleware, createSecurityHeadersHook } from "./auth/middleware.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { cleanupRetention, startRetentionTicker } from "./db/retention.js";
import { startDockerDiscovery } from "./docker/discovery.js";
import type { IngestHooks } from "./status/ingest.js";
import { MonitorPool } from "./monitors/pool.js";
import { MonitorScheduler } from "./monitors/scheduler.js";
import { startStaleChecker } from "./monitors/staleChecker.js";
import { createWebhookDispatcher } from "./webhooks/dispatcher.js";
import { broadcastServiceUpdate, createWsHub, registerWsRoutes } from "./ws/hub.js";
import { registerStatusRoutes } from "./routes/status.js";
import { registerServicesRoutes } from "./routes/services.js";
import { registerGroupsRoutes } from "./routes/groups.js";
import { registerMaintenanceRoutes } from "./routes/maintenance.js";
import { registerMonitorRoutes } from "./routes/monitors.js";
import { registerDiagnosticsRoutes } from "./routes/diagnostics.js";
import { registerActivityRoutes } from "./routes/activity.js";
import { registerBackupRoutes } from "./routes/backup.js";
import { registerMetaRoutes } from "./routes/meta.js";
import { registerDockerRoutes } from "./routes/docker.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerUptimeRoutes } from "./routes/uptime.js";

const cfg = loadConfig();
const db = openDatabase(cfg);

await seedCredentialsFromEnv(db, cfg);

// Run an initial cleanup so stale rows are gone immediately on startup,
// matching main.go initDB's call to cleanupRetention before returning.
cleanupRetention(db, cfg);
startRetentionTicker(db, cfg);

const app = Fastify({ logger: true });
await app.register(fastifyCookie);

// Ported from main.go setupRoutes (~L1904-1910): permissive CORS for
// homelab use (AllowedOrigins ["*"], AllowedMethods
// GET/POST/PUT/DELETE/OPTIONS, AllowedHeaders ["*"], AllowCredentials
// false).
//
// gzip compression (matching gzipMiddleware, ~L1955-1988) was tried via
// @fastify/compress with { global: true }, but it hits a known unresolved
// upstream bug (fastify/fastify#6017): the response stream closes
// prematurely for payloads over ~16KB whenever the client sends
// Accept-Encoding: gzip — which every real browser does by default. That
// turned GET /api/services (routinely >16KB once a few services/history
// rows exist) into a 200 OK with an empty body, silently crashing the
// client on the resulting `undefined`. Dropped entirely rather than chase
// an upstream bug closed by the Fastify maintainers as "not planned" —
// uncompressed JSON is a fine tradeoff for a self-hosted homelab dashboard.
await app.register(fastifyCors, {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: "*",
  credentials: false,
});

// Ported from main.go's middleware chain order: security headers, then
// auth. Registered before route registration so both hooks apply to every
// route below, including 401s from the auth hook (gzip still applies to
// those too, matching Go's gzip(auth(cors(router))) wrapping order).
app.addHook("onRequest", createSecurityHeadersHook(cfg));
app.addHook("onRequest", createAuthMiddleware(db, cfg));

await registerAuthRoutes(app, db, cfg);

// Webhook dispatch and websocket broadcast, wired for real (Phase 3).
const dispatcher = createWebhookDispatcher(db, cfg);
const hub = createWsHub();
await registerWsRoutes(app, hub);

const ingestHooks: IngestHooks = {
  onNotify: (serviceName, prevStatus, status, message) => {
    dispatcher.enqueue(serviceName, prevStatus, status, message);
  },
  onWrite: (serviceName) => {
    broadcastServiceUpdate(hub, db, cfg, serviceName);
  },
};

await startDockerDiscovery(db, cfg, ingestHooks);

const monitorPool = new MonitorPool(db, cfg, ingestHooks);
const monitorScheduler = new MonitorScheduler(db, monitorPool);
monitorScheduler.loadAndStartAll();

await registerStatusRoutes(app, db, cfg, ingestHooks);
await registerServicesRoutes(app, db, cfg);
await registerGroupsRoutes(app, db);
await registerMaintenanceRoutes(app, db);
await registerMonitorRoutes(app, db, monitorScheduler);
await registerDiagnosticsRoutes(app, db);
await registerActivityRoutes(app, db);
await registerBackupRoutes(app, db, cfg);
await registerMetaRoutes(app, db);
await registerDockerRoutes(app, db, cfg);
await registerWebhookRoutes(app, db, cfg, dispatcher);
await registerUptimeRoutes(app, db, cfg);

startStaleChecker(db, cfg, ingestHooks);

// Serves the built client (client/dist) in production, e.g. Docker, where
// this server is the single deployable and the frontend has no dev server
// of its own. authExemptPath's "static shell" catch-all already treats any
// non-API/non-WS path as public, matching a client-rendered SPA that gates
// its own UI on GET /api/auth/session — the server never protects the JS
// bundle itself, only the data it fetches. Skipped when unset (`npm run
// dev`, where Vite serves the client and proxies /api + /ws here instead).
if (cfg.staticDir !== "" && existsSync(cfg.staticDir)) {
  await app.register(fastifyStatic, { root: cfg.staticDir });
  app.setNotFoundHandler((request, reply) => {
    if (request.raw.method === "GET" && !request.url.startsWith("/api/") && request.url !== "/ws") {
      reply.sendFile("index.html");
      return;
    }
    reply.code(404).send({ error: "not found" });
  });
}

app.listen({ port: cfg.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
