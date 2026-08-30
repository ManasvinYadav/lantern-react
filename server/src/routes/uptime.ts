import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import {
  buildTimeline,
  fetchEvents,
  fetchLastEventBefore,
  isDown,
  isInMaintenance,
  parseRange,
  statusAtTime,
  statusPriority,
} from "../metrics/compute.js";
import type { StatusBucket } from "../metrics/compute.js";

// strconv.Atoi is all-or-nothing (no partial parse, unlike Number.parseInt
// which happily reads "48xyz" as 48) — matched here so an out-of-shape
// `hours` query param falls back to the default exactly like the Go route.
function parseIntStrict(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

// Ported from extensions.go handleGetUptime/handleGetStrip/handleGetIncidents
// (~L258-630). All three reconstruct the same timeline (fetchEvents +
// fetchLastEventBefore + buildTimeline) and only differ in what they fold
// over it. Each handler wraps its whole body in try/catch rather than only
// the fetchEvents call Go explicitly error-checks: better-sqlite3 throws
// synchronously instead of returning (result, err), so this is the natural
// TS shape for "any DB error here becomes a 500", not a scope expansion.
export async function registerUptimeRoutes(app: FastifyInstance, db: Database.Database, cfg: Config) {
  // Registered at both "/api/services/:name/uptime" and its
  // "/api/public/services/:name/uptime" duplicate (main.go setupRoutes
  // ~L1900: publicApi.Handle("/services/{name}/uptime", handleGetUptime(db))
  // — same handler, no auth-relevant difference beyond the exemption
  // already applied in authExemptPath).
  const getUptime = async (
    request: FastifyRequest<{ Params: { name: string }; Querystring: { range?: string } }>,
    reply: FastifyReply
  ) => {
      const { name } = request.params;
      const rng = request.query.range || "7d";

      try {
        const hours = parseRange(rng);
        const now = new Date();
        const nowMs = now.getTime();
        const since = new Date(nowMs - hours * 60 * 60 * 1000);

        const events = fetchEvents(db, name, since);
        const prior = fetchLastEventBefore(db, name, since);
        const timeline = buildTimeline(prior, events, since);

        let totalSec = (nowMs - since.getTime()) / 1000;
        if (totalSec <= 0) totalSec = 1;

        let downSec = 0;
        let emptySec = 0;
        let incidentCount = 0;
        let inIncident = false;

        for (let i = 0; i < timeline.length; i++) {
          const seg = timeline[i];
          const end = i + 1 < timeline.length ? timeline[i + 1].start : now;
          let dur = (end.getTime() - seg.start.getTime()) / 1000;
          if (dur < 0) dur = 0;

          if (seg.status === "empty") {
            emptySec += dur;
            inIncident = false;
            continue;
          }
          if (isDown(seg.status)) {
            if (!isInMaintenance(db, name, seg.start)) {
              downSec += dur;
            }
            if (!inIncident) {
              incidentCount++;
              inIncident = true;
            }
          } else {
            inIncident = false;
          }
        }

        let effectiveTotalSec = totalSec - emptySec;
        if (effectiveTotalSec <= 0) effectiveTotalSec = 1;

        let uptimePct = Math.round(((effectiveTotalSec - downSec) / effectiveTotalSec) * 100 * 100) / 100;
        if (uptimePct > 100) uptimePct = 100;
        if (uptimePct < 0) uptimePct = 0;

        let dpIntervalMs: number;
        switch (rng) {
          case "1h":
            dpIntervalMs = 2 * 60 * 1000;
            break;
          case "24h":
            dpIntervalMs = 30 * 60 * 1000;
            break;
          case "7d":
            dpIntervalMs = 3 * 60 * 60 * 1000;
            break;
          case "30d":
            dpIntervalMs = 12 * 60 * 60 * 1000;
            break;
          default:
            dpIntervalMs = 3 * 60 * 60 * 1000;
        }

        const datapoints: { timestamp: string; uptime_pct: number }[] = [];
        for (let t = since.getTime(); t < nowMs; t += dpIntervalMs) {
          let bucketEnd = t + dpIntervalMs;
          if (bucketEnd > nowMs) bucketEnd = nowMs;
          const bucketTotal = (bucketEnd - t) / 1000;
          if (bucketTotal <= 0) continue;

          let bucketDown = 0;
          let bs = statusAtTime(timeline, new Date(t));
          let cursor = t;

          for (const seg of timeline) {
            const segStartMs = seg.start.getTime();
            if (!(segStartMs > t) || segStartMs > bucketEnd) continue;
            if (segStartMs > cursor) {
              if (isDown(bs)) {
                bucketDown += (segStartMs - cursor) / 1000;
              }
              cursor = segStartMs;
            }
            bs = seg.status;
          }
          if (bucketEnd > cursor) {
            if (isDown(bs)) {
              bucketDown += (bucketEnd - cursor) / 1000;
            }
          }

          let dpUptime = Math.round(((bucketTotal - bucketDown) / bucketTotal) * 100 * 100) / 100;
          if (dpUptime > 100) dpUptime = 100;
          datapoints.push({ timestamp: new Date(t).toISOString(), uptime_pct: dpUptime });
        }

        reply.send({
          service_name: name,
          range: rng,
          uptime_pct: uptimePct,
          total_downtime_minutes: Math.round((downSec / 60) * 100) / 100,
          total_incidents: incidentCount,
          datapoints,
        });
      } catch (err) {
        app.log.error(err, "handleGetUptime db error");
        reply.code(500).send({ error: "database error" });
      }
  };

  app.get<{ Params: { name: string }; Querystring: { range?: string } }>("/api/services/:name/uptime", getUptime);
  app.get<{ Params: { name: string }; Querystring: { range?: string } }>(
    "/api/public/services/:name/uptime",
    getUptime
  );

  app.get<{ Params: { name: string }; Querystring: { hours?: string } }>(
    "/api/services/:name/strip",
    async (request, reply) => {
      const { name } = request.params;

      try {
        let hours = 24;
        const hoursStr = request.query.hours;
        if (hoursStr !== undefined) {
          const h = parseIntStrict(hoursStr);
          if (h !== null && h > 0 && h <= 720) {
            hours = h;
          }
        }

        const now = new Date();
        const nowMs = now.getTime();
        const since = new Date(nowMs - hours * 60 * 60 * 1000);

        const events = fetchEvents(db, name, since);
        const prior = fetchLastEventBefore(db, name, since);
        const timeline = buildTimeline(prior, events, since);

        // 48 buckets for 24h, scaled for other ranges, capped at 96.
        let numBuckets = hours * 2;
        if (numBuckets > 96) numBuckets = 96;
        if (numBuckets < 1) numBuckets = 1;
        const bucketDurMs = (hours * 60 * 60 * 1000) / numBuckets;

        const buckets: StatusBucket[] = [];
        for (let i = 0; i < numBuckets; i++) {
          const bStartMs = since.getTime() + i * bucketDurMs;
          let bEndMs = bStartMs + bucketDurMs;
          if (bEndMs > nowMs) bEndMs = nowMs;
          const bDur = (bEndMs - bStartMs) / 1000;
          if (bDur <= 0) {
            buckets.push({ start: new Date(bStartMs).toISOString(), status: "unknown" });
            continue;
          }

          const statusTime = new Map<string, number>();
          let bs = statusAtTime(timeline, new Date(bStartMs));
          let cursor = bStartMs;

          for (const s of timeline) {
            const sStartMs = s.start.getTime();
            if (!(sStartMs > bStartMs) || sStartMs > bEndMs) continue;
            if (sStartMs > cursor) {
              statusTime.set(bs, (statusTime.get(bs) ?? 0) + (sStartMs - cursor) / 1000);
              cursor = sStartMs;
            }
            bs = s.status;
          }
          if (bEndMs > cursor) {
            statusTime.set(bs, (statusTime.get(bs) ?? 0) + (bEndMs - cursor) / 1000);
          }

          let dominant = "unknown";
          let maxDur = 0;
          for (const [st, d] of statusTime) {
            if (d > maxDur || (d === maxDur && statusPriority(st) > statusPriority(dominant))) {
              dominant = st;
              maxDur = d;
            }
          }

          buckets.push({ start: new Date(bStartMs).toISOString(), status: dominant });
        }

        reply.send({ service_name: name, hours, buckets });
      } catch (err) {
        app.log.error(err, "handleGetStrip db error");
        reply.code(500).send({ error: "database error" });
      }
    }
  );

  app.get<{ Params: { name: string }; Querystring: { range?: string } }>(
    "/api/services/:name/incidents",
    async (request, reply) => {
      const { name } = request.params;
      const rng = request.query.range || "30d";

      try {
        const hours = parseRange(rng);
        const now = new Date();
        const since = new Date(now.getTime() - hours * 60 * 60 * 1000);

        const events = fetchEvents(db, name, since);
        const prior = fetchLastEventBefore(db, name, since);
        const timeline = buildTimeline(prior, events, since);

        const incidents: {
          started_at: string;
          ended_at: string;
          duration_minutes: number;
          trigger_status: string;
          trigger_message: string;
          in_maintenance: boolean;
        }[] = [];
        let incStart: Date | null = null;
        let triggerStatus = "";
        let triggerMsg = "";
        let totalDownSec = 0;

        for (let i = 0; i < timeline.length; i++) {
          const seg = timeline[i];
          const end = i + 1 < timeline.length ? timeline[i + 1].start : now;

          if (isDown(seg.status)) {
            const dur = (end.getTime() - seg.start.getTime()) / 1000;
            if (dur > 0) totalDownSec += dur;
            if (incStart === null) {
              incStart = seg.start;
              triggerStatus = seg.status;
              triggerMsg = seg.message;
            }
          } else if (incStart !== null) {
            const inMaint = isInMaintenance(db, name, incStart);
            const durMin = (seg.start.getTime() - incStart.getTime()) / 60000;
            incidents.push({
              started_at: incStart.toISOString(),
              ended_at: seg.start.toISOString(),
              duration_minutes: Math.round(durMin * 100) / 100,
              trigger_status: triggerStatus,
              trigger_message: triggerMsg,
              in_maintenance: inMaint,
            });
            incStart = null;
          }
        }

        // Still in an incident at the end of the window.
        if (incStart !== null) {
          const inMaint = isInMaintenance(db, name, incStart);
          const durMin = (now.getTime() - incStart.getTime()) / 60000;
          incidents.push({
            started_at: incStart.toISOString(),
            ended_at: "",
            duration_minutes: Math.round(durMin * 100) / 100,
            trigger_status: triggerStatus,
            trigger_message: triggerMsg,
            in_maintenance: inMaint,
          });
        }

        reply.send({
          service_name: name,
          range: rng,
          total_downtime_minutes: Math.round((totalDownSec / 60) * 100) / 100,
          incidents,
        });
      } catch (err) {
        app.log.error(err, "handleGetIncidents db error");
        reply.code(500).send({ error: "database error" });
      }
    }
  );
}
