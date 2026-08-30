import type Database from "better-sqlite3";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { authRequired, verifyCredentials } from "./credentials.js";
import { sessionUser } from "./sessions.js";
import { constantTimeEquals } from "./timing.js";
import { lookupScopedToken } from "./tokens.js";

declare module "fastify" {
  interface FastifyRequest {
    authContext?: {
      isAdmin?: boolean;
      sessionUsername?: string;
      scopedService?: string;
    };
  }
}

// Ported from auth.go authExemptPath (~L405-429). Static function, not
// config-driven: which paths are open with zero credentials is a code-level
// decision, never an env var.
export function authExemptPath(path: string): boolean {
  if (path.startsWith("/api/public/") || path.startsWith("/api/badge/")) return true;
  if (path === "/metrics") return true;
  if (path === "/api/health" || path === "/api/docs") return true;
  if (path === "/api/auth/session" || path === "/api/auth/login") return true;
  if (path === "/ws") return false;
  if (path.startsWith("/api/")) return false;
  return true; // static shell
}

// Ported verbatim from main.go isProtectedEndpoint (~L386-441): the
// hand-picked list of mutating/administrative routes that need a
// credential once one is configured, even though the rest of the API
// stays open under token-only mode.
export function isProtectedEndpoint(path: string, method: string): boolean {
  if (path.includes("/docker/")) return true;

  if (path === "/api/auth/credentials") return true;
  if (path === "/api/backup") return true;
  if (path === "/api/webhooks" && method === "GET") return true;
  if (path.startsWith("/api/config/")) return true;
  if (path === "/api/banner" && method !== "GET") return true;
  if (path.endsWith("/alerts") && method !== "GET") return true;
  if (path === "/api/status" && method === "POST") return true;
  if (path === "/api/diagnostics" && method === "POST") return true;
  if (path === "/api/webhooks" && (method === "PUT" || method === "POST")) return true;
  if (path === "/api/webhooks/test" && method === "POST") return true;
  if (path.endsWith("/group") && method !== "GET") return true;
  if (path.endsWith("/maintenance") && method !== "GET") return true;
  if (path.endsWith("/monitor") && method !== "GET") return true;
  if (path.endsWith("/check") && method === "POST") return true;
  if (path.startsWith("/api/services/") && method === "DELETE") return true;

  return false;
}

function parseBasicAuth(header: string | undefined): { user: string; pass: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
    const sepIndex = decoded.indexOf(":");
    if (sepIndex === -1) return null;
    return { user: decoded.slice(0, sepIndex), pass: decoded.slice(sepIndex + 1) };
  } catch {
    return null;
  }
}

// Ported verbatim from auth.go authMiddleware (~L433-500), as a Fastify
// onRequest hook. Order matters: session cookie, then bearer (admin token
// then scoped token), then Basic Auth, then the open/gated fallback.
export function createAuthMiddleware(db: Database.Database, cfg: Config) {
  return async function authMiddleware(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.url.split("?")[0];
    if (authExemptPath(path)) return;

    // 1. Session cookie. Also the only credential a browser can attach to a
    //    WebSocket handshake, which is what makes /ws work under auth.
    const cookieToken = request.cookies?.lantern_session;
    if (cookieToken) {
      const user = sessionUser(db, cookieToken);
      if (user) {
        request.authContext = { isAdmin: true, sessionUsername: user };
        return;
      }
    }

    // 2. Bearer: the admin-wide token, then per-service scoped tokens.
    const authHeader = request.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length);

      if (cfg.authToken !== "" && constantTimeEquals(token, cfg.authToken)) {
        request.authContext = { isAdmin: true };
        return;
      }

      const serviceName = lookupScopedToken(db, token);
      if (serviceName) {
        request.authContext = { scopedService: serviceName };
        return;
      }
    }

    // 3. Basic Auth, validated against the store once it is seeded and
    //    against the env pair otherwise, so curl -u keeps working.
    const basic = parseBasicAuth(authHeader);
    if (basic) {
      let valid = false;
      if (authRequired()) {
        valid = await verifyCredentials(db, basic.user, basic.pass);
      } else if (cfg.authEnabled) {
        valid =
          constantTimeEquals(basic.user, cfg.authUser) && constantTimeEquals(basic.pass, cfg.authPass);
      }
      if (valid) {
        request.authContext = { isAdmin: true, sessionUsername: basic.user };
        return;
      }
    }

    // 4. Nothing authenticated. What that costs depends on the mode.
    if (authRequired()) {
      reply.header("WWW-Authenticate", 'Basic realm="Lantern"');
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    if (cfg.authEnabled) {
      reply.header("WWW-Authenticate", 'Basic realm="Lantern"');
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    if (cfg.authToken !== "" && isProtectedEndpoint(path, request.method)) {
      reply.header("WWW-Authenticate", "Bearer");
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }
    // No credentials configured anywhere: the dashboard is open, which is
    // Lantern's out-of-the-box behavior.
  };
}

// Ported from main.go securityHeadersMiddleware (~L464-487).
export function createSecurityHeadersHook(cfg: Config) {
  const frameAncestors = cfg.frameAncestors !== "" ? cfg.frameAncestors : "'self'";
  const csp =
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "base-uri 'self'; " +
    "form-action 'self'; " +
    "frame-ancestors " +
    frameAncestors;

  return async function securityHeaders(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Content-Security-Policy", csp);
    if (frameAncestors === "'self'") {
      reply.header("X-Frame-Options", "SAMEORIGIN");
    }
  };
}
