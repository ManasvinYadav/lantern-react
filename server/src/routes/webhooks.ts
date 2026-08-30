import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import {
  getEffectiveWebhookURL,
  isWebhookChannel,
  sendWebhookRequest,
  WEBHOOK_CHANNELS,
  type WebhookChannel,
  type WebhookDispatcher,
} from "../webhooks/dispatcher.js";

// strconv.Atoi is all-or-nothing (no partial parse, unlike Number.parseInt
// which happily reads "48xyz" as 48) — matched here so an out-of-shape
// `limit` query param falls back to the default exactly like the Go route.
// Duplicated from routes/uptime.ts's local helper of the same name, per
// that file's own precedent of keeping it file-local rather than shared.
function parseIntStrict(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

// Ported from main.go handlePutWebhooks's saveChannel closure (~L1556-1569).
// Throws on an invalid channel or a DB failure; handleSaveWebhooks below
// maps any throw to the same 400 response Go's saveChannel error return
// produced, whether the cause was validation or the db.Exec call itself.
function saveChannel(db: Database.Database, chRaw: string, rawURL: string): void {
  const ch = chRaw.trim().toLowerCase();
  if (!isWebhookChannel(ch)) {
    throw new Error(`invalid channel: ${ch}`);
  }
  const url = rawURL.trim();
  if (url === "") {
    db.prepare("DELETE FROM webhook_configs WHERE channel = ?").run(ch);
  } else {
    db.prepare(
      `INSERT INTO webhook_configs (channel, url) VALUES (?, ?)
       ON CONFLICT(channel) DO UPDATE SET url = excluded.url`
    ).run(ch, url);
  }
}

interface PutWebhooksBody {
  [key: string]: string;
}

interface TestWebhookBody {
  channel?: string;
}

interface WebhookDeliveriesQuery {
  limit?: string;
}

interface RawDeliveryRow {
  id: number;
  channel: string;
  service_name: string;
  old_status: string;
  new_status: string;
  success: number;
  http_status: number;
  error: string;
  created_at: string;
}

// Ported from main.go handleGetWebhooks/handlePutWebhooks/handleTestWebhook/
// handleGetWebhookDeliveries (~L1522-1687). Registers GET/PUT/POST
// /api/webhooks, POST /api/webhooks/test, and GET /api/webhooks/deliveries.
// Auth for the mutating routes is already enforced globally by
// auth/middleware.ts's isProtectedEndpoint, so no auth check is repeated
// here. `dispatcher` is accepted for signature consistency with the ingest
// path (main.go's setupRoutes wires the same *webhookDispatcher into both
// places) but no handler below calls it: the Go original's webhook routes
// never enqueue through the dispatcher themselves — only dispatchWebhooks
// (invoked from ingestStatusEvent) does — and handleTestWebhook posts
// directly via the bare http.Post, bypassing the queue entirely.
export async function registerWebhookRoutes(
  app: FastifyInstance,
  db: Database.Database,
  cfg: Config,
  dispatcher: WebhookDispatcher
) {
  // Ported from main.go handleGetWebhooks (~L1529-1543).
  app.get("/api/webhooks", async (_request, reply) => {
    const resp: Record<string, { configured: boolean; url: string; source: string }> = {};
    for (const ch of WEBHOOK_CHANNELS) {
      const { url, source } = getEffectiveWebhookURL(db, cfg, ch);
      resp[ch] = { configured: url !== "", url, source };
    }
    reply.send(resp);
  });

  // Ported from main.go handlePutWebhooks (~L1546-1589). Registered for both
  // PUT and POST, matching main.go's router.Methods(http.MethodPut,
  // http.MethodPost) on the same path.
  async function handleSaveWebhooks(
    request: FastifyRequest<{ Body: PutWebhooksBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const req = request.body;
    if (!req || typeof req !== "object") {
      reply.code(400).send({ error: "invalid json payload" });
      return;
    }

    try {
      // Single channel payload: { "channel": "discord", "url": "..." }
      if (Object.prototype.hasOwnProperty.call(req, "channel")) {
        saveChannel(db, req.channel ?? "", req.url ?? "");
      } else {
        // Multi-channel map: { "discord": "...", "telegram": "..." }
        for (const [ch, rawURL] of Object.entries(req)) {
          saveChannel(db, ch, rawURL);
        }
      }
    } catch (err) {
      reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    reply.send({ status: "ok", message: "webhook configurations updated" });
  }

  app.put<{ Body: PutWebhooksBody }>("/api/webhooks", handleSaveWebhooks);
  app.post<{ Body: PutWebhooksBody }>("/api/webhooks", handleSaveWebhooks);

  // Ported from main.go handleTestWebhook (~L1592-1635). Posts directly via
  // sendWebhookRequest (bypassing the dispatcher's queue/worker pool and
  // webhook_deliveries, matching handleTestWebhook's use of the bare
  // http.Post in the Go original rather than the dispatcher) and returns the
  // outcome synchronously in the response instead of recording it. Channels
  // are tested sequentially, matching Go's blocking http.Post calls one
  // after another inside doTest.
  app.post<{ Body: TestWebhookBody }>("/api/webhooks/test", async (request, reply) => {
    let channel = (request.body?.channel ?? "").trim();
    if (channel === "") channel = "all";
    channel = channel.toLowerCase();

    const testMsg = "🔆 Lantern Test Webhook: Notifications are working correctly!";
    const results: Record<string, Record<string, unknown>> = {};

    const doTest = async (name: WebhookChannel, payload: unknown): Promise<void> => {
      if (channel !== "all" && channel !== name) return;
      const { url, source } = getEffectiveWebhookURL(db, cfg, name);
      if (url === "") {
        results[name] = { attempted: false, source: "none", message: "Webhook URL not configured" };
        return;
      }
      const { success, httpStatus, errMsg } = await sendWebhookRequest(url, JSON.stringify(payload));
      if (httpStatus === 0) {
        results[name] = { attempted: true, success: false, source, message: errMsg };
      } else {
        results[name] = { attempted: true, success, source, status_code: httpStatus };
      }
    };

    await doTest("discord", { content: testMsg });
    await doTest("telegram", { text: testMsg });
    await doTest("gotify", { title: "Lantern Alert", message: testMsg });
    await doTest("generic", { content: testMsg });

    reply.send({ status: "ok", results });
  });

  // Ported from main.go handleGetWebhookDeliveries (~L1653-1687).
  app.get<{ Querystring: WebhookDeliveriesQuery }>("/api/webhooks/deliveries", async (request, reply) => {
    let limit = 20;
    const v = request.query.limit;
    if (v) {
      const n = parseIntStrict(v);
      if (n !== null && n > 0 && n <= 200) limit = n;
    }

    const rows = db
      .prepare(
        `SELECT id, channel, service_name, COALESCE(old_status,'') AS old_status, COALESCE(new_status,'') AS new_status,
                success, COALESCE(http_status,0) AS http_status, COALESCE(error,'') AS error, created_at
         FROM webhook_deliveries
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(limit) as RawDeliveryRow[];

    const deliveries = rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      service_name: r.service_name,
      old_status: r.old_status,
      new_status: r.new_status,
      success: r.success === 1,
      http_status: r.http_status,
      error: r.error,
      created_at: r.created_at,
    }));

    reply.send(deliveries);
  });
}
