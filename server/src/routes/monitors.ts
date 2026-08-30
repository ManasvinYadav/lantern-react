import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { MonitorScheduler } from "../monitors/scheduler.js";
import {
  MAX_MONITOR_INTERVAL_SECONDS,
  MIN_MONITOR_INTERVAL_SECONDS,
  VALID_MONITOR_TYPES,
} from "../monitors/constants.js";

interface ActiveMonitorRow {
  service_name: string;
  monitor_type: string;
  target: string;
  interval_seconds: number;
  enabled: number;
  last_checked_at: string | null;
  cert_expiry_at: string | null;
}

interface PutMonitorBody {
  monitor_type?: string;
  target?: string;
  interval_seconds?: number;
  enabled?: boolean | null;
}

const CERT_EXPIRY_WARNING_DAYS = 14;

// Ported from monitors.go applyCertFields (~L330-344). cert_warning here is
// a fixed 14-day threshold local to this endpoint — independent of the
// cfg-driven certWarnDays/certCriticalDays thresholds monitors/certStatus.ts
// uses to annotate live check messages, since the Go original never wires
// cfg into this handler either. cert_expiry_at is still surfaced even if it
// fails to parse (matching Go setting m.CertExpiryAt before the parse
// attempt); only cert_days_remaining/cert_warning stay at their zero values
// in that case.
function toActiveMonitorJson(row: ActiveMonitorRow) {
  let certDaysRemaining: number | null = null;
  let certWarning = false;
  if (row.cert_expiry_at !== null) {
    const expiry = new Date(row.cert_expiry_at);
    if (!Number.isNaN(expiry.getTime())) {
      const hoursRemaining = (expiry.getTime() - Date.now()) / (1000 * 60 * 60);
      certDaysRemaining = Math.trunc(hoursRemaining / 24);
      certWarning = certDaysRemaining <= CERT_EXPIRY_WARNING_DAYS;
    }
  }
  return {
    service_name: row.service_name,
    monitor_type: row.monitor_type,
    target: row.target,
    interval_seconds: row.interval_seconds,
    enabled: row.enabled === 1,
    last_checked_at: row.last_checked_at,
    cert_expiry_at: row.cert_expiry_at,
    cert_days_remaining: certDaysRemaining,
    cert_warning: certWarning,
  };
}

// Mirrors the shape net.SplitHostPort requires (host:port, or [host]:port
// for bracketed IPv6) closely enough for validation purposes; Node has no
// direct equivalent. A second unbracketed colon reads as bare IPv6 without
// brackets, which SplitHostPort also rejects ("too many colons in address").
function isValidHostPort(target: string): boolean {
  if (target.startsWith("[")) {
    const closeIdx = target.indexOf("]");
    if (closeIdx === -1) return false;
    const rest = target.slice(closeIdx + 1);
    if (!rest.startsWith(":")) return false;
    const port = rest.slice(1);
    return port.length > 0 && !port.includes(":");
  }
  const idx = target.lastIndexOf(":");
  if (idx === -1) return false;
  const host = target.slice(0, idx);
  const port = target.slice(idx + 1);
  if (host.length === 0 || port.length === 0) return false;
  if (host.includes(":")) return false;
  return true;
}

// Ported from monitors.go validateMonitorTarget (~L308-328). Returns the
// error message to 400 with, or null when target is acceptable.
function validateMonitorTarget(monitorType: string, rawTarget: string): string | null {
  const target = rawTarget.trim();
  if (target === "") return "target is required";
  switch (monitorType) {
    case "http":
      if (!target.startsWith("http://") && !target.startsWith("https://")) {
        return "http target must start with http:// or https://";
      }
      return null;
    case "tcp":
      if (!isValidHostPort(target)) return "tcp target must be host:port";
      return null;
    case "ping":
      return null;
    default:
      return "monitor_type must be one of: http, tcp, ping";
  }
}

export async function registerMonitorRoutes(
  app: FastifyInstance,
  db: Database.Database,
  scheduler: MonitorScheduler
) {
  // Ported from monitors.go handleGetMonitors (~L346-374): lists every
  // configured active monitor. Go skips rows that fail to Scan; better-
  // sqlite3 has no per-row scan step (a query either returns rows or
  // throws), so that per-row skip has no TS equivalent.
  app.get("/api/monitors", async (_request, reply) => {
    let rows: ActiveMonitorRow[];
    try {
      rows = db
        .prepare(
          "SELECT service_name, monitor_type, target, interval_seconds, enabled, last_checked_at, cert_expiry_at FROM active_monitors ORDER BY service_name ASC"
        )
        .all() as ActiveMonitorRow[];
    } catch (err) {
      app.log.error(err, "handleGetMonitors db error");
      reply.code(500).send({ error: "database error" });
      return;
    }
    reply.send(rows.map(toActiveMonitorJson));
  });

  // Ported from monitors.go handleGetServiceMonitor (~L376-401).
  app.get<{ Params: { name: string } }>("/api/services/:name/monitor", async (request, reply) => {
    const { name } = request.params;
    let row: ActiveMonitorRow | undefined;
    try {
      row = db
        .prepare(
          "SELECT service_name, monitor_type, target, interval_seconds, enabled, last_checked_at, cert_expiry_at FROM active_monitors WHERE service_name = ?"
        )
        .get(name) as ActiveMonitorRow | undefined;
    } catch (err) {
      app.log.error(err, "handleGetServiceMonitor db error");
      reply.code(500).send({ error: "database error" });
      return;
    }
    if (!row) {
      reply.code(404).send({ error: "no active monitor configured for this service" });
      return;
    }
    reply.send(toActiveMonitorJson(row));
  });

  // Ported from monitors.go handlePutServiceMonitor (~L403-478): creates or
  // updates, then (re)starts or stops the scheduler ticker for this service
  // to match. The success response is built in-memory from the validated
  // request, not re-read from the DB — matching Go, which does the same and
  // so leaves last_checked_at/cert_* at their zero values on every call.
  const putServiceMonitor = async (
    request: FastifyRequest<{ Params: { name: string }; Body: PutMonitorBody }>,
    reply: FastifyReply
  ) => {
    const name = (request.params.name ?? "").trim();
    if (name === "") {
      reply.code(400).send({ error: "service name is required" });
      return;
    }

    const body = request.body ?? {};
    const monitorType = (body.monitor_type ?? "").trim().toLowerCase();
    if (!VALID_MONITOR_TYPES.has(monitorType)) {
      reply.code(400).send({ error: "monitor_type must be one of: http, tcp, ping" });
      return;
    }

    const targetErr = validateMonitorTarget(monitorType, body.target ?? "");
    if (targetErr) {
      reply.code(400).send({ error: targetErr });
      return;
    }
    const target = (body.target ?? "").trim();

    let intervalSeconds = body.interval_seconds ?? 0;
    if (intervalSeconds === 0) intervalSeconds = 60;
    if (intervalSeconds < MIN_MONITOR_INTERVAL_SECONDS || intervalSeconds > MAX_MONITOR_INTERVAL_SECONDS) {
      reply.code(400).send({
        error: `interval_seconds must be between ${MIN_MONITOR_INTERVAL_SECONDS} and ${MAX_MONITOR_INTERVAL_SECONDS}`,
      });
      return;
    }

    // `?? true` covers both an absent key and an explicit `null`, matching
    // Go's *bool field being nil in both cases.
    const enabled = body.enabled ?? true;
    const enabledInt = enabled ? 1 : 0;

    try {
      db.prepare(
        `
INSERT INTO active_monitors (service_name, monitor_type, target, interval_seconds, enabled, updated_at)
VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
ON CONFLICT(service_name) DO UPDATE SET
    monitor_type = excluded.monitor_type,
    target = excluded.target,
    interval_seconds = excluded.interval_seconds,
    enabled = excluded.enabled,
    updated_at = CURRENT_TIMESTAMP`
      ).run(name, monitorType, target, intervalSeconds, enabledInt);
    } catch (err) {
      app.log.error(err, "handlePutServiceMonitor db error");
      reply.code(500).send({ error: "database error" });
      return;
    }

    if (enabled) {
      scheduler.start(name, monitorType, target, intervalSeconds);
    } else {
      scheduler.stop(name);
    }

    reply.send({
      service_name: name,
      monitor_type: monitorType,
      target,
      interval_seconds: intervalSeconds,
      enabled,
      last_checked_at: null,
      cert_expiry_at: null,
      cert_days_remaining: null,
      cert_warning: false,
    });
  };

  app.put<{ Params: { name: string }; Body: PutMonitorBody }>("/api/services/:name/monitor", putServiceMonitor);
  app.post<{ Params: { name: string }; Body: PutMonitorBody }>("/api/services/:name/monitor", putServiceMonitor);

  // Ported from monitors.go handleDeleteServiceMonitor (~L480-495): removes
  // the active-check config; the service reverts to push-only. Always
  // stops the scheduler and returns 200, even if no monitor was configured
  // for this service — matches Go, which never checks rows-affected.
  app.delete<{ Params: { name: string } }>("/api/services/:name/monitor", async (request, reply) => {
    const { name } = request.params;
    scheduler.stop(name);
    try {
      db.prepare("DELETE FROM active_monitors WHERE service_name = ?").run(name);
    } catch (err) {
      app.log.error(err, "handleDeleteServiceMonitor db error");
      reply.code(500).send({ error: "database error" });
      return;
    }
    reply.send({ status: "ok", service_name: name });
  });
}
