import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { buildServiceSummary } from "../services/summary.js";

// strconv.Atoi is all-or-nothing (no partial parse, unlike Number.parseInt
// which happily reads "48xyz" as 48) — same gap routes/uptime.ts's
// parseIntStrict documents, duplicated here since that one isn't exported.
function parseIntStrict(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

interface StatusEventRow {
  id: number;
  status: string;
  message: string | null;
  timestamp: string;
}

interface StatusEventHistoryRow extends StatusEventRow {
  latency_ms: number;
}

interface PutGroupBody {
  group?: string;
  group_name?: string;
}

// Go's encoding/csv quotes a field that contains a comma, a double quote, a
// CR, or an LF, or that starts with whitespace; internal quotes are doubled.
// Records are terminated with "\n" (Writer.UseCRLF defaults to false).
function csvField(v: string): string {
  if (v === "") return v;
  if (/[",\r\n]/.test(v) || /^\s/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function toCsv(events: { id: number; status: string; message: string; timestamp: string }[]): string {
  const lines = ["id,status,message,timestamp"];
  for (const e of events) {
    lines.push([String(e.id), e.status, e.message, e.timestamp].map(csvField).join(","));
  }
  return lines.join("\n") + "\n";
}

// Go's strings.Map replaces every rune outside [a-zA-Z0-9_-] with '_'; the
// regex form below does the same per UTF-16 code unit (matches for the
// ASCII service names this is meant to sanitize).
function safeFilenamePart(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Ported from main.go handleGetServices/handlePostStatus's group sibling
// (~L1031-1105, ~L1105-1224, ~L1800-1845). Registers GET /api/services (and
// its /api/public/services duplicate — setupRoutes' publicApi subrouter,
// main.go:1897 — same handler, no auth-relevant difference beyond the
// exemption already applied in authExemptPath), GET
// /api/services/:name/history, GET /api/services/:name/export, and PUT+POST
// /api/services/:name/group.
export async function registerServicesRoutes(app: FastifyInstance, db: Database.Database, cfg: Config) {
  // Go's handleGetServices runs one joined query returning the latest row
  // per service, then fans out concurrent goroutines to attach uptime/
  // history per row. buildServiceSummary (services/summary.ts) already
  // reproduces that whole per-service computation (join + stale +
  // maintenance + cached uptime + history) for the single-service case, so
  // this reuses it per name rather than re-deriving the join here — the
  // per-service goroutine fan-out has no observable effect since
  // better-sqlite3 is synchronous and Node is single-threaded anyway.
  const listServices = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const names = db
        .prepare("SELECT DISTINCT service_name FROM status_events ORDER BY service_name ASC")
        .all() as { service_name: string }[];

      const services = [];
      for (const { service_name } of names) {
        const summary = buildServiceSummary(db, cfg, service_name);
        if (summary) services.push(summary);
      }

      reply.send(services);
    } catch (err) {
      app.log.error(err, "handleGetServices db error");
      reply.code(500).send({ error: "database error" });
    }
  };

  app.get("/api/services", listServices);
  app.get("/api/public/services", listServices);

  app.get<{ Params: { name: string }; Querystring: { limit?: string; offset?: string } }>(
    "/api/services/:name/history",
    async (request, reply) => {
      const { name } = request.params;

      let limit = 100;
      const limitStr = request.query.limit;
      if (limitStr) {
        const n = parseIntStrict(limitStr);
        if (n !== null && n > 0) limit = n;
      }
      if (limit > 500) limit = 500;

      let offset = 0;
      const offsetStr = request.query.offset;
      if (offsetStr) {
        const n = parseIntStrict(offsetStr);
        if (n !== null && n >= 0) offset = n;
      }

      try {
        const rows = db
          .prepare(
            `SELECT id, status, message, timestamp, COALESCE(latency_ms, 0) AS latency_ms FROM status_events
             WHERE service_name = ? ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?`
          )
          .all(name, limit, offset) as StatusEventHistoryRow[];

        const events = rows.map((r) => ({
          id: r.id,
          status: r.status,
          message: r.message ?? "",
          timestamp: r.timestamp,
          latency_ms: r.latency_ms,
        }));

        reply.send({ service_name: name, events });
      } catch (err) {
        app.log.error(err, "handleGetServiceHistory db error");
        reply.code(500).send({ error: "database error" });
      }
    }
  );

  app.get<{ Params: { name: string }; Querystring: { format?: string } }>(
    "/api/services/:name/export",
    async (request, reply) => {
      const { name } = request.params;
      const format = (request.query.format ?? "").trim().toLowerCase() || "json";
      if (format !== "csv" && format !== "json") {
        reply.code(400).send({ error: "format must be csv or json" });
        return;
      }

      let events: { id: number; status: string; message: string; timestamp: string }[];
      try {
        const rows = db
          .prepare(
            `SELECT id, status, COALESCE(message,'') AS message, timestamp FROM status_events
             WHERE service_name = ? ORDER BY timestamp ASC, id ASC`
          )
          .all(name) as StatusEventRow[];
        events = rows.map((r) => ({ id: r.id, status: r.status, message: r.message ?? "", timestamp: r.timestamp }));
      } catch (err) {
        app.log.error(err, "handleExportServiceHistory db error");
        reply.code(500).send({ error: "database error" });
        return;
      }

      const safeName = safeFilenamePart(name);

      if (format === "csv") {
        reply.header("Content-Type", "text/csv");
        reply.header("Content-Disposition", `attachment; filename="${safeName}-history.csv"`);
        reply.send(toCsv(events));
        return;
      }

      reply.header("Content-Type", "application/json");
      reply.header("Content-Disposition", `attachment; filename="${safeName}-history.json"`);
      reply.send(events);
    }
  );

  const putGroup = async (
    request: FastifyRequest<{ Params: { name: string }; Body: PutGroupBody }>,
    reply: FastifyReply
  ) => {
    const name = (request.params.name ?? "").trim();
    if (name === "") {
      reply.code(400).send({ error: "service name is required" });
      return;
    }

    const scopedSvc = request.authContext?.scopedService;
    if (scopedSvc !== undefined && scopedSvc !== name) {
      reply.code(403).send({ error: "token not scoped for this service" });
      return;
    }

    const body = request.body;
    if (!body || typeof body !== "object") {
      reply.code(400).send({ error: "invalid json body" });
      return;
    }

    let group = (body.group ?? "").trim();
    if (group === "") {
      group = (body.group_name ?? "").trim();
    }

    try {
      db.prepare(
        `INSERT INTO service_groups (service_name, group_name, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(service_name) DO UPDATE SET group_name = excluded.group_name, updated_at = CURRENT_TIMESTAMP`
      ).run(name, group);
    } catch (err) {
      app.log.error(err, "handlePutServiceGroup db error");
      reply.code(500).send({ error: "database error" });
      return;
    }

    reply.send({ status: "ok", service_name: name, group_name: group });
  };

  app.put<{ Params: { name: string }; Body: PutGroupBody }>("/api/services/:name/group", putGroup);
  app.post<{ Params: { name: string }; Body: PutGroupBody }>("/api/services/:name/group", putGroup);
}
