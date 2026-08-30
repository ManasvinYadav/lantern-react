import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

interface ActivityEvent {
  type: "status_change" | "webhook_delivery";
  service_name: string;
  status?: string;
  message?: string;
  channel?: string;
  success?: boolean;
  http_status?: number;
  error?: string;
  timestamp: string;
}

interface StatusEventRow {
  service_name: string;
  status: string;
  message: string;
  timestamp: string;
}

interface WebhookDeliveryRow {
  channel: string;
  service_name: string;
  success: number;
  http_status: number;
  error: string;
  created_at: string;
}

// strconv.Atoi is all-or-nothing, unlike Number.parseInt — matched so an
// out-of-shape limit query param falls back to the default like the Go route.
function parseIntStrict(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

// Ported from main.go handleGetActivity (~L1706-1759): a chronological feed
// of every status change and webhook delivery attempt across all services,
// merged and sorted by timestamp descending, then capped at limit.
export async function registerActivityRoutes(app: FastifyInstance, db: Database.Database) {
  app.get<{ Querystring: { limit?: string } }>("/api/activity", async (request, reply) => {
    let limit = 50;
    const limitStr = request.query.limit;
    if (limitStr !== undefined && limitStr !== "") {
      const n = parseIntStrict(limitStr);
      if (n !== null && n > 0 && n <= 200) limit = n;
    }

    try {
      const events: ActivityEvent[] = [];

      const statusRows = db
        .prepare(
          `SELECT service_name, status, COALESCE(message,'') as message, timestamp
FROM status_events ORDER BY id DESC LIMIT ?`
        )
        .all(limit) as StatusEventRow[];
      for (const row of statusRows) {
        // Key order mirrors Go's ActivityEvent struct field order
        // (type, service_name, status, message, ..., timestamp) since it
        // determines JSON output order.
        const e: ActivityEvent = {
          type: "status_change",
          service_name: row.service_name,
          ...(row.status !== "" ? { status: row.status } : {}),
          ...(row.message !== "" ? { message: row.message } : {}),
          timestamp: row.timestamp,
        };
        events.push(e);
      }

      const whRows = db
        .prepare(
          `SELECT channel, service_name, success, COALESCE(http_status,0) as http_status, COALESCE(error,'') as error, created_at
FROM webhook_deliveries ORDER BY id DESC LIMIT ?`
        )
        .all(limit) as WebhookDeliveryRow[];
      for (const row of whRows) {
        // Success is a *bool in Go (omitempty on nil only), so it's always
        // present here since webhook rows always set it, even when false.
        const e: ActivityEvent = {
          type: "webhook_delivery",
          service_name: row.service_name,
          ...(row.channel !== "" ? { channel: row.channel } : {}),
          success: row.success === 1,
          ...(row.http_status !== 0 ? { http_status: row.http_status } : {}),
          ...(row.error !== "" ? { error: row.error } : {}),
          timestamp: row.created_at,
        };
        events.push(e);
      }

      events.sort((a, b) => (a.timestamp > b.timestamp ? -1 : a.timestamp < b.timestamp ? 1 : 0));
      const trimmed = events.length > limit ? events.slice(0, limit) : events;

      reply.send(trimmed);
    } catch (err) {
      app.log.error(err, "handleGetActivity db error");
      reply.code(500).send({ error: "database error" });
    }
  });
}
