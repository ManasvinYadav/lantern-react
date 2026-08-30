import type Database from "better-sqlite3";
import type { Config } from "../config.js";

export const WEBHOOK_CHANNELS = ["discord", "telegram", "gotify", "generic"] as const;
export type WebhookChannel = (typeof WEBHOOK_CHANNELS)[number];
export type WebhookSource = "db" | "env" | "none";

const WEBHOOK_CHANNEL_SET = new Set<string>(WEBHOOK_CHANNELS);

export function isWebhookChannel(value: string): value is WebhookChannel {
  return WEBHOOK_CHANNEL_SET.has(value);
}

const WEBHOOK_QUEUE_SIZE = 256;

// Env var names main.go's loadConfig (~L73-78) reads into cfg.WebhookDiscord
// etc. cfg: Config (config.ts) does not carry those fields — this subsystem
// predates them in the port — so the env fallback below reads process.env
// directly by the same names instead. Behaviorally identical: these are
// read-only-at-process-start values in the Go original too.
const WEBHOOK_ENV_VAR: Record<WebhookChannel, string> = {
  discord: "LANTERN_WEBHOOK_DISCORD",
  telegram: "LANTERN_WEBHOOK_TELEGRAM",
  gotify: "LANTERN_WEBHOOK_GOTIFY",
  generic: "LANTERN_WEBHOOK_GENERIC",
};

interface WebhookConfigRow {
  url: string;
}

// Ported from main.go getEffectiveWebhookURL (~L687-714): a channel's URL
// comes from the webhook_configs table if a non-blank row exists, else from
// the matching env var, else it's unconfigured. Exported so routes.ts's
// GET /api/webhooks and POST /api/webhooks/test reuse this instead of
// re-deriving channel URLs themselves.
export function getEffectiveWebhookURL(
  db: Database.Database,
  _cfg: Config,
  channel: WebhookChannel
): { url: string; source: WebhookSource } {
  const row = db.prepare("SELECT url FROM webhook_configs WHERE channel = ?").get(channel) as
    | WebhookConfigRow
    | undefined;
  if (row && row.url.trim() !== "") {
    return { url: row.url.trim(), source: "db" };
  }
  const envVal = process.env[WEBHOOK_ENV_VAR[channel]];
  if (envVal) {
    return { url: envVal, source: "env" };
  }
  return { url: "", source: "none" };
}

// discordColorForStatus mirrors main.go (~L819-830): the dashboard's own
// status colors (--up/--down/--degraded/--unknown), so alerts read
// consistently with the UI.
function discordColorForStatus(status: string): number {
  switch (status) {
    case "up":
      return 0x10b981;
    case "down":
      return 0xf43f5e;
    case "degraded":
      return 0xf59e0b;
    default:
      return 0x64748b;
  }
}

// Ported from main.go buildDiscordEmbedPayload (~L832-860): a structured,
// color-coded embed instead of a plain-text content string, so a status
// change is scannable at a glance in Discord.
function buildDiscordEmbedPayload(service: string, oldStatus: string, newStatus: string, message: string): string {
  let title = "Service Status Change";
  if (newStatus === "up") title = "✅ Service Recovered";
  else if (newStatus === "down") title = "🔴 Service Down";
  else if (newStatus === "degraded") title = "🟡 Service Degraded";

  const msg = message === "" ? "—" : message;

  const embed = {
    title,
    color: discordColorForStatus(newStatus),
    fields: [
      { name: "Service", value: service, inline: true },
      { name: "Status", value: `${oldStatus.toUpperCase()} → ${newStatus.toUpperCase()}`, inline: true },
      { name: "Message", value: msg, inline: false },
    ],
    timestamp: new Date().toISOString(),
  };
  return JSON.stringify({ embeds: [embed] });
}

interface WebhookJob {
  channel: WebhookChannel;
  url: string;
  payload: string;
  service: string;
  oldStatus: string;
  newStatus: string;
}

// Ported from main.go webhookDispatcher.worker's HTTP call (~L751-771): a
// transport/network error yields success=false, httpStatus=0, errMsg set to
// the error text; a completed response is success iff status < 400, with
// errMsg set to "http <status>" on a non-2xx status. Exported so
// routes.ts's POST /api/webhooks/test reuses the exact same send/classify
// logic instead of duplicating it (that route posts directly, bypassing the
// queue/worker pool, matching handleTestWebhook's use of the bare
// http.Post rather than the dispatcher in the Go original).
export async function sendWebhookRequest(
  url: string,
  payload: string
): Promise<{ success: boolean; httpStatus: number; errMsg: string }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(10_000),
    });
    // Drain the body so the connection can be released, mirroring Go's
    // resp.Body.Close(). Nothing here needs the body's content.
    await res.arrayBuffer().catch(() => undefined);
    const success = res.status < 400;
    return { success, httpStatus: res.status, errMsg: success ? "" : `http ${res.status}` };
  } catch (err) {
    return { success: false, httpStatus: 0, errMsg: err instanceof Error ? err.message : String(err) };
  }
}

export interface WebhookDispatcher {
  enqueue(serviceName: string, prevStatus: string, status: string, message: string): void;
}

// Ported from main.go newWebhookDispatcher/webhookDispatcher (~L731-797).
// Go uses a buffered channel (size webhookQueueSize=256) drained by a fixed
// pool of goroutines; this reproduces the same bound (queued-but-unstarted
// jobs capped at 256, at most workerCount running concurrently) with a plain
// array + an in-flight counter, since Node has no goroutines. enqueue still
// returns immediately without awaiting delivery, matching the Go original.
export function createWebhookDispatcher(
  db: Database.Database,
  cfg: Config,
  workerCount = 4
): WebhookDispatcher {
  const queue: WebhookJob[] = [];
  let active = 0;

  // Ported from main.go webhookDispatcher.recordDelivery (~L785-797).
  function recordDelivery(job: WebhookJob, success: boolean, httpStatus: number, errMsg: string): void {
    try {
      db.prepare(
        `INSERT INTO webhook_deliveries (channel, service_name, old_status, new_status, success, http_status, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        job.channel,
        job.service,
        job.oldStatus,
        job.newStatus,
        success ? 1 : 0,
        httpStatus,
        errMsg,
        new Date().toISOString()
      );
    } catch (err) {
      console.error(`failed to record webhook delivery: ${err}`);
    }
  }

  // Ported from main.go webhookDispatcher.worker (~L751-771).
  async function runJob(job: WebhookJob): Promise<void> {
    const { success, httpStatus, errMsg } = await sendWebhookRequest(job.url, job.payload);
    if (!success) {
      if (httpStatus === 0) {
        console.error(`webhook dispatch failed: channel=${job.channel} service=${job.service} err=${errMsg}`);
      } else {
        console.error(`webhook dispatch non-2xx: channel=${job.channel} service=${job.service} status=${httpStatus}`);
      }
    }
    recordDelivery(job, success, httpStatus, errMsg);
  }

  function pump(): void {
    while (active < workerCount && queue.length > 0) {
      const job = queue.shift() as WebhookJob;
      active++;
      runJob(job).finally(() => {
        active--;
        pump();
      });
    }
  }

  // Ported from main.go webhookDispatcher.enqueue (~L773-783): non-blocking
  // submit. A full queue (a sustained outage across many channels) drops the
  // job and records the drop rather than backing up ingestion.
  function enqueueJob(job: WebhookJob): void {
    if (queue.length >= WEBHOOK_QUEUE_SIZE) {
      console.error(`webhook queue full, dropping job: channel=${job.channel} service=${job.service}`);
      recordDelivery(job, false, 0, "delivery queue full, job dropped");
      return;
    }
    queue.push(job);
    pump();
  }

  // Ported from main.go dispatchWebhooks (~L862-881): decides which
  // configured channel(s) to notify and formats the message per channel.
  // Enqueues one job per configured channel and returns immediately —
  // actual HTTP calls happen asynchronously via runJob/pump above.
  function dispatch(service: string, oldStatus: string, newStatus: string, message: string): void {
    const text = `Service ${service} changed from ${oldStatus} to ${newStatus}. ${message}`;

    const discord = getEffectiveWebhookURL(db, cfg, "discord");
    if (discord.url !== "") {
      enqueueJob({
        channel: "discord",
        url: discord.url,
        payload: buildDiscordEmbedPayload(service, oldStatus, newStatus, message),
        service,
        oldStatus,
        newStatus,
      });
    }

    const telegram = getEffectiveWebhookURL(db, cfg, "telegram");
    if (telegram.url !== "") {
      enqueueJob({
        channel: "telegram",
        url: telegram.url,
        payload: JSON.stringify({ text }),
        service,
        oldStatus,
        newStatus,
      });
    }

    const gotify = getEffectiveWebhookURL(db, cfg, "gotify");
    if (gotify.url !== "") {
      enqueueJob({
        channel: "gotify",
        url: gotify.url,
        payload: JSON.stringify({ title: "Lantern Alert", message: text }),
        service,
        oldStatus,
        newStatus,
      });
    }

    const generic = getEffectiveWebhookURL(db, cfg, "generic");
    if (generic.url !== "") {
      enqueueJob({
        channel: "generic",
        url: generic.url,
        payload: JSON.stringify({ service, old: oldStatus, new: newStatus, message }),
        service,
        oldStatus,
        newStatus,
      });
    }
  }

  return {
    enqueue: dispatch,
  };
}
