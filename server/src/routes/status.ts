import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { ingestStatusEvent, type IngestHooks } from "../status/ingest.js";
import { setMaintenanceState } from "./maintenance.js";

const VALID_STATUSES = new Set(["up", "down", "degraded", "unknown"]);

interface PostStatusBody {
  service_name?: string;
  status?: string;
  message?: string;
  timestamp?: string;
  group_name?: string;
  maintenance?: boolean;
  latency_ms?: number;
}

// Go's time.Parse(time.RFC3339, ts) is all-or-nothing like strconv.Atoi
// (routes/uptime.ts's parseIntStrict note applies here too): a string that
// doesn't fit RFC 3339 falls back to "now" rather than being loosely
// reinterpreted the way `new Date(str)` would (e.g. "2024-01-15" or
// "2024-01-15 10:00:00" both parse fine in JS but would fail Go's strict
// layout match). Matched with a format check before handing off to Date.
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// Ported from main.go parseTimestamp (~L931-940).
function parseTimestamp(ts: string | undefined): Date {
  if (!ts) return new Date();
  if (!RFC3339_RE.test(ts)) return new Date();
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

// Ported from main.go handlePostStatus (~L1242-1298). ingestStatusEvent's
// write path itself already lives at status/ingest.ts (Phase 2); this
// handler reproduces the validation, the optional group/maintenance side
// writes, and the response shape around that call. latency_ms is an
// optional reporter-supplied value (main.go:515-517, StatusEventRequest.
// LatencyMs): a reporter may omit it entirely, and nil/negative are treated
// as 0 so a bad client can never write a nonsense duration into the beat.
export async function registerStatusRoutes(
  app: FastifyInstance,
  db: Database.Database,
  cfg: Config,
  hooks: IngestHooks
) {
  app.post<{ Body: PostStatusBody }>("/api/status", async (request, reply) => {
    const body = request.body;
    // Fastify's own JSON content-type parser already rejects malformed JSON
    // syntax before this handler runs (see routes/maintenance.ts's same
    // note); this covers the no-body-sent case Fastify lets through as
    // `undefined`, mirroring Go's json.Decode error path.
    if (!body || typeof body !== "object") {
      reply.code(400).send({ error: "invalid JSON body" });
      return;
    }

    const serviceName = (body.service_name ?? "").trim();
    const status = (body.status ?? "").trim().toLowerCase();

    if (serviceName === "") {
      reply.code(400).send({ error: "service_name is required" });
      return;
    }
    if (!VALID_STATUSES.has(status)) {
      reply.code(400).send({ error: "status must be one of: up, down, degraded, unknown" });
      return;
    }

    const ts = parseTimestamp(body.timestamp);

    const scopedSvc = request.authContext?.scopedService;
    if (scopedSvc !== undefined && scopedSvc !== serviceName) {
      reply.code(403).send({ error: "token not scoped for this service" });
      return;
    }

    const groupName = (body.group_name ?? "").trim();
    if (groupName !== "") {
      // Go: `_, _ = db.Exec(...)` — this write's errors are deliberately
      // swallowed so a group-table hiccup never blocks a status push.
      try {
        db.prepare(
          `INSERT INTO service_groups (service_name, group_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(service_name) DO UPDATE SET group_name = excluded.group_name, updated_at = CURRENT_TIMESTAMP`
        ).run(serviceName, groupName);
      } catch (err) {
        app.log.error(err, "handlePostStatus group upsert error");
      }
    }

    // req.Maintenance is a Go *bool: present-and-false still toggles, while
    // an absent field OR an explicit JSON `null` (both decode to a nil
    // pointer in Go) leave state untouched.
    if (body.maintenance !== undefined && body.maintenance !== null) {
      try {
        setMaintenanceState(db, serviceName, body.maintenance, "");
      } catch (err) {
        app.log.error(err, "handlePostStatus maintenance toggle error");
      }
    }

    const latencyMs = body.latency_ms !== undefined && body.latency_ms > 0 ? body.latency_ms : 0;

    try {
      const id = ingestStatusEvent(db, serviceName, status, body.message ?? "", ts, latencyMs, hooks);
      reply.code(201).send({ id });
    } catch (err) {
      app.log.error(err, "handlePostStatus db error");
      reply.code(500).send({ error: "database error" });
    }
  });
}
