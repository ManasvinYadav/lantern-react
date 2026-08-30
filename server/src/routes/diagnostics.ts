import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

interface DiagnosticRunRequestBody {
  service_name?: string;
  title?: string;
  content?: string;
  timestamp?: string;
}

interface DiagnosticRunRow {
  id: number;
  service_name: string;
  title: string;
  timestamp: string;
  created_at: string;
}

interface DiagnosticRunDetailRow extends DiagnosticRunRow {
  content: string;
}

// strconv.Atoi is all-or-nothing (no partial parse, unlike Number.parseInt
// which happily reads "48xyz" as 48) — matched so an out-of-shape limit/
// offset/id query param falls back to the default exactly like the Go route.
function parseIntStrict(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

// Ported from main.go parseTimestamp (~L931-940). JS's Date constructor is
// looser than Go's strict time.Parse(time.RFC3339, ...) — an out-of-format
// string that Date can still coerce won't fall back to "now" the way Go's
// would. No stricter RFC 3339 parser is available without a new dependency.
function parseTimestamp(ts: string): Date {
  if (ts === "") return new Date();
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return new Date();
  return parsed;
}

// Ported from main.go handlePostDiagnostics/handleGetDiagnostics/
// handleGetDiagnosticByID (~L1261-1407).
export async function registerDiagnosticsRoutes(app: FastifyInstance, db: Database.Database) {
  app.post<{ Body: DiagnosticRunRequestBody }>("/api/diagnostics", async (request, reply) => {
    const body = request.body;
    // Go's json.Decode fails (and 400s "invalid JSON body", main.go:1265) on
    // a missing/unparsable body; Fastify's own JSON content-type parser
    // already rejects malformed JSON syntax before this handler runs, so
    // this covers the no-body-sent case Fastify lets through as `undefined`
    // (see routes/maintenance.ts's same note).
    if (!body || typeof body !== "object") {
      reply.code(400).send({ error: "invalid JSON body" });
      return;
    }

    const serviceName = (body.service_name ?? "").trim();
    const title = (body.title ?? "").trim();
    const content = body.content ?? ""; // not trimmed, matching Go

    if (serviceName === "") {
      reply.code(400).send({ error: "service_name is required" });
      return;
    }
    if (title === "") {
      reply.code(400).send({ error: "title is required" });
      return;
    }
    if (content === "") {
      reply.code(400).send({ error: "content is required" });
      return;
    }

    const ts = parseTimestamp(body.timestamp ?? "");

    const scopedService = request.authContext?.scopedService;
    if (scopedService !== undefined && scopedService !== serviceName) {
      reply.code(403).send({ error: "token not scoped for this service" });
      return;
    }

    try {
      // Go queries the service's last status here but never reads the
      // result (main.go:1293-1294) — vestigial, kept only for fidelity;
      // it has no effect on the response or the insert below.
      db.prepare("SELECT status FROM status_events WHERE service_name = ? ORDER BY id DESC LIMIT 1").get(
        serviceName
      );

      const result = db
        .prepare(
          "INSERT INTO diagnostic_runs (service_name, title, content, timestamp) VALUES (?, ?, ?, ?)"
        )
        .run(serviceName, title, content, ts.toISOString());

      reply.code(201).send({ id: Number(result.lastInsertRowid) });
    } catch (err) {
      app.log.error(err, "handlePostDiagnostics db error");
      reply.code(500).send({ error: "database error" });
    }
  });

  app.get<{ Querystring: { service_name?: string; limit?: string; offset?: string } }>(
    "/api/diagnostics",
    async (request, reply) => {
      const serviceName = request.query.service_name ?? "";

      let limit = 20;
      const limitStr = request.query.limit;
      if (limitStr !== undefined && limitStr !== "") {
        const n = parseIntStrict(limitStr);
        if (n !== null && n > 0) limit = n;
      }
      if (limit > 500) limit = 500;

      let offset = 0;
      const offsetStr = request.query.offset;
      if (offsetStr !== undefined && offsetStr !== "") {
        const n = parseIntStrict(offsetStr);
        if (n !== null && n >= 0) offset = n;
      }

      try {
        const rows = (
          serviceName !== ""
            ? db
                .prepare(
                  `SELECT id, service_name, title, timestamp, created_at
FROM diagnostic_runs
WHERE service_name = ?
ORDER BY timestamp DESC, id DESC
LIMIT ? OFFSET ?`
                )
                .all(serviceName, limit, offset)
            : db
                .prepare(
                  `SELECT id, service_name, title, timestamp, created_at
FROM diagnostic_runs
ORDER BY timestamp DESC, id DESC
LIMIT ? OFFSET ?`
                )
                .all(limit, offset)
        ) as DiagnosticRunRow[];

        reply.send(rows);
      } catch (err) {
        app.log.error(err, "handleGetDiagnostics db error");
        reply.code(500).send({ error: "database error" });
      }
    }
  );

  app.get<{ Params: { id: string } }>("/api/diagnostics/:id", async (request, reply) => {
    const id = parseIntStrict(request.params.id);
    if (id === null) {
      reply.code(400).send({ error: "invalid diagnostic id" });
      return;
    }

    try {
      const row = db
        .prepare(
          `SELECT id, service_name, title, content, timestamp, created_at
FROM diagnostic_runs WHERE id = ?`
        )
        .get(id) as DiagnosticRunDetailRow | undefined;

      if (!row) {
        reply.code(404).send({ error: "diagnostic run not found" });
        return;
      }

      // Field order matches Go's DiagnosticRunDetail struct (embeds
      // DiagnosticRunSummary, so id/service_name/title/timestamp/created_at
      // come before content) rather than the SELECT's column order.
      reply.send({
        id: row.id,
        service_name: row.service_name,
        title: row.title,
        timestamp: row.timestamp,
        created_at: row.created_at,
        content: row.content,
      });
    } catch (err) {
      app.log.error(err, "handleGetDiagnosticByID db error");
      reply.code(500).send({ error: "database error" });
    }
  });
}
