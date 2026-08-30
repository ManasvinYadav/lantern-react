import type Database from "better-sqlite3";

// Shared read-only computation layer: status-history reconstruction and the
// uptime/incident math built on top of it. Consumed by the REST routes in
// ../routes/uptime.ts and by ../services/summary.ts (which the WebSocket
// broadcaster also depends on).

// Ported from extensions.go StatusBucket (~L51-54).
export interface StatusBucket {
  start: string;
  status: string;
}

// Ported from main.go HeartbeatBeat (~L558-565): "empty" is a left-padding
// placeholder (not a real check) used to keep the heartbeat bar a fixed
// length for services with fewer than `limit` recorded checks. latency_ms is
// 0 for "empty" padding beats and for any event whose source didn't report
// one.
export interface HeartbeatBeat {
  status: string;
  timestamp: string;
  msg: string;
  latency_ms: number;
}

// Ported from extensions.go rawEvent (~L82-86). Named RawEvent (PascalCase)
// to match this codebase's interface-naming convention.
export interface RawEvent {
  status: string;
  message: string;
  timestamp: Date;
}

// Ported from extensions.go segment (~L209-213): one (time, status) knot in
// a service's reconstructed timeline, built by buildTimeline.
export interface Segment {
  start: Date;
  status: string;
  message: string;
}

// Ported from extensions.go fetchEvents (~L88-112). since is bound via
// toISOString() (not Go's fractionless RFC3339) to match the millisecond-
// precision timestamps status/ingest.ts already writes — see schema.ts and
// ingest.ts's `timestamp.toISOString()`. Mixing formats would break the
// lexicographic string comparison SQLite uses for `timestamp >= ?`.
export function fetchEvents(db: Database.Database, name: string, since: Date): RawEvent[] {
  const rows = db
    .prepare(
      `SELECT status, COALESCE(message,'') AS message, timestamp FROM status_events
       WHERE service_name = ? AND timestamp >= ?
       ORDER BY timestamp ASC`
    )
    .all(name, since.toISOString()) as { status: string; message: string; timestamp: string }[];
  return rows.map((r) => ({ status: r.status, message: r.message, timestamp: new Date(r.timestamp) }));
}

// Ported from extensions.go fetchRecentBeats/leftPadEmptyBeats (~L114-159).
export function fetchRecentBeats(db: Database.Database, name: string, limit: number): HeartbeatBeat[] {
  const rows = db
    .prepare(
      `SELECT status, COALESCE(message,'') AS message, timestamp, COALESCE(latency_ms, 0) AS latency_ms
       FROM status_events
       WHERE service_name = ?
       ORDER BY id DESC LIMIT ?`
    )
    .all(name, limit) as { status: string; message: string; timestamp: string; latency_ms: number }[];

  const beats: HeartbeatBeat[] = rows
    .map((r) => ({ status: r.status, timestamp: r.timestamp, msg: r.message, latency_ms: r.latency_ms }))
    .reverse();

  if (beats.length >= limit) return beats;
  const padding: HeartbeatBeat[] = Array.from({ length: limit - beats.length }, () => ({
    status: "empty",
    timestamp: "",
    msg: "",
    latency_ms: 0,
  }));
  return [...padding, ...beats];
}

// Ported from extensions.go fetchLastEventBefore (~L161-176).
export function fetchLastEventBefore(db: Database.Database, name: string, before: Date): RawEvent | null {
  const row = db
    .prepare(
      `SELECT status, COALESCE(message,'') AS message, timestamp FROM status_events
       WHERE service_name = ? AND timestamp < ?
       ORDER BY timestamp DESC LIMIT 1`
    )
    .get(name, before.toISOString()) as
    | { status: string; message: string; timestamp: string }
    | undefined;
  if (!row) return null;
  return { status: row.status, message: row.message, timestamp: new Date(row.timestamp) };
}

// Ported from extensions.go isInMaintenance (~L178-190).
export function isInMaintenance(db: Database.Database, name: string, t: Date): boolean {
  const tStr = t.toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM maintenance_windows
       WHERE service_name = ? AND started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)`
    )
    .get(name, tStr, tStr) as { count: number };
  return row.count > 0;
}

// Ported from extensions.go parseRange (~L192-206). Not in the caller's
// required-exports list but shared by every uptime.ts route, so it lives
// here alongside the rest of the range/timeline computation.
export function parseRange(rng: string): number {
  switch (rng) {
    case "1h":
      return 1;
    case "24h":
      return 24;
    case "7d":
      return 24 * 7;
    case "30d":
      return 24 * 30;
    default:
      return 24 * 7;
  }
}

// Ported from extensions.go buildTimeline (~L215-235): when there's no
// event before `since` (new service, or no history at all), the leading
// segment is "empty" rather than "unknown" — callers exclude "empty" from
// uptime/incident totals entirely instead of counting it as up.
export function buildTimeline(prior: RawEvent | null, events: RawEvent[], since: Date): Segment[] {
  let startStatus = "empty";
  let startMsg = "";
  if (prior !== null) {
    startStatus = prior.status;
    startMsg = prior.message;
  }
  const tl: Segment[] = [{ start: since, status: startStatus, message: startMsg }];
  for (const e of events) {
    tl.push({ start: e.timestamp, status: e.status, message: e.message });
  }
  return tl;
}

// Ported from extensions.go statusAtTime (~L237-248).
export function statusAtTime(timeline: Segment[], t: Date): string {
  let status = "unknown";
  const tMs = t.getTime();
  for (const s of timeline) {
    if (s.start.getTime() <= tMs) {
      status = s.status;
    } else {
      break;
    }
  }
  return status;
}

// Ported from extensions.go isDown (~L250-252).
export function isDown(status: string): boolean {
  return status === "down" || status === "degraded";
}

// Ported from extensions.go statusPriority (~L498-509). Used to break ties
// when picking a bucket's dominant status.
export function statusPriority(s: string): number {
  switch (s) {
    case "down":
      return 3;
    case "degraded":
      return 2;
    case "up":
      return 1;
    default:
      return 0;
  }
}

// Ported from extensions.go computeServiceMetricsUnified (~L863-1024): 7d
// uptime, 30d uptime, and 30 daily status buckets in one pass over 30 days
// of events. Returns a 3-tuple to mirror Go's multiple return values; the
// 3rd element (buckets) is discarded with `_` by every Go call site today
// (main.go:635,1091,1462) so it has no live behavioral consequence, but is
// preserved bit-for-bit including two quirks: (1) the nextIdx-correction
// `if` inside the bucket loop is dead in practice — timeline[0].start is
// always `since30d`, which is never After any bStart, so the branch that
// resets nextIdx to len(timeline) never fires, even in the "no segment
// after bStart" case it looks like it's meant to catch; ported as-is rather
// than "fixed". (2) Go's map iteration order is randomized, so a duration
// tie between two *equal-priority* statuses (anything outside
// down/degraded/up, e.g. "empty" vs "maintenance") can pick either one
// nondeterministically across runs; JS Map iterates in insertion order, so
// this port is deterministic for that edge case instead. Distinct-priority
// ties (e.g. down vs up) resolve identically in both languages regardless
// of order.
export function computeServiceMetricsUnified(
  db: Database.Database,
  serviceName: string
): [number, number, StatusBucket[]] {
  const now = new Date();
  const nowMs = now.getTime();
  const since30d = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
  const since7d = new Date(nowMs - 7 * 24 * 60 * 60 * 1000);
  const since7dMs = since7d.getTime();

  let events: RawEvent[];
  try {
    events = fetchEvents(db, serviceName, since30d);
  } catch {
    return [0, 0, []];
  }
  const prior = fetchLastEventBefore(db, serviceName, since30d);
  const timeline = buildTimeline(prior, events, since30d);

  let totalSec30d = (nowMs - since30d.getTime()) / 1000;
  if (totalSec30d <= 0) totalSec30d = 1;
  let totalSec7d = (nowMs - since7dMs) / 1000;
  if (totalSec7d <= 0) totalSec7d = 1;

  let downSec30d = 0;
  let downSec7d = 0;
  let emptySec30d = 0;
  let emptySec7d = 0;

  for (let i = 0; i < timeline.length; i++) {
    const s = timeline[i];
    let end = i + 1 < timeline.length ? timeline[i + 1].start : now;
    if (end.getTime() > nowMs) end = now;

    let dur30d = (end.getTime() - s.start.getTime()) / 1000;
    if (dur30d < 0) dur30d = 0;

    let segStart7dMs = s.start.getTime();
    if (segStart7dMs < since7dMs) segStart7dMs = since7dMs;
    let dur7d = 0;
    if (end.getTime() > since7dMs) {
      dur7d = (end.getTime() - segStart7dMs) / 1000;
      if (dur7d < 0) dur7d = 0;
    }

    if (s.status === "empty") {
      emptySec30d += dur30d;
      emptySec7d += dur7d;
      continue;
    }

    if (isDown(s.status)) {
      downSec30d += dur30d;
      downSec7d += dur7d;
    }
  }

  let effectiveTotalSec30d = totalSec30d - emptySec30d;
  if (effectiveTotalSec30d <= 0) effectiveTotalSec30d = 1;
  let effectiveTotalSec7d = totalSec7d - emptySec7d;
  if (effectiveTotalSec7d <= 0) effectiveTotalSec7d = 1;

  let pct30d = Math.round(((effectiveTotalSec30d - downSec30d) / effectiveTotalSec30d) * 100 * 10) / 10;
  if (pct30d > 100) pct30d = 100;
  if (pct30d < 0) pct30d = 0;

  let pct7d = Math.round(((effectiveTotalSec7d - downSec7d) / effectiveTotalSec7d) * 100 * 100) / 100;
  if (pct7d > 100) pct7d = 100;
  if (pct7d < 0) pct7d = 0;

  const numBuckets = 30;
  const bucketDurMs = (30 * 24 * 60 * 60 * 1000) / numBuckets;
  const buckets: StatusBucket[] = [];

  for (let i = 0; i < numBuckets; i++) {
    const bStartMs = since30d.getTime() + i * bucketDurMs;
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

    let nextIdx = 0;
    for (let j = 0; j < timeline.length; j++) {
      if (timeline[j].start.getTime() > bStartMs) {
        nextIdx = j;
        break;
      }
    }
    if (nextIdx === 0 && (timeline.length === 0 || timeline[0].start.getTime() > bStartMs)) {
      nextIdx = timeline.length;
    }

    while (cursor < bEndMs) {
      let segEndMs: number;
      if (nextIdx < timeline.length) {
        segEndMs = timeline[nextIdx].start.getTime();
      } else {
        segEndMs = nowMs;
      }
      if (segEndMs > bEndMs) segEndMs = bEndMs;

      const d = (segEndMs - cursor) / 1000;
      if (d > 0) {
        statusTime.set(bs, (statusTime.get(bs) ?? 0) + d);
      }
      cursor = segEndMs;

      if (nextIdx < timeline.length) {
        bs = timeline[nextIdx].status;
        nextIdx++;
      } else {
        break;
      }
    }

    let dom = "unknown";
    let maxT = -1.0;
    for (const [st, t] of statusTime) {
      if (t > maxT || (t === maxT && statusPriority(st) > statusPriority(dom))) {
        maxT = t;
        dom = st;
      }
    }
    if (maxT <= 0) {
      dom = "unknown";
    } else if (dom !== "up" && isInMaintenance(db, serviceName, new Date(bStartMs))) {
      dom = "maintenance";
    }

    buckets.push({ start: new Date(bStartMs).toISOString(), status: dom });
  }

  return [pct7d, pct30d, buckets];
}

interface CachedServiceMetrics {
  uptime7d: number;
  uptime30d: number;
  history: StatusBucket[];
  cachedAtMs: number;
}

const METRICS_CACHE_TTL_MS = 15_000;
const metricsCache = new Map<string, CachedServiceMetrics>();

// Ported from extensions.go getCachedOrComputeServiceMetrics (~L1038-1059).
// Go guards the package-level cache with a sync.RWMutex because multiple
// goroutines can hit it concurrently; Node's single-threaded event loop
// (this Map is never touched from an await boundary) makes that
// unnecessary here, so the 15s TTL is the only invalidation rule ported.
export function getCachedOrComputeServiceMetrics(
  db: Database.Database,
  serviceName: string
): [number, number, StatusBucket[]] {
  const cached = metricsCache.get(serviceName);
  if (cached && Date.now() - cached.cachedAtMs < METRICS_CACHE_TTL_MS) {
    return [cached.uptime7d, cached.uptime30d, cached.history];
  }

  const [up7, up30, buckets] = computeServiceMetricsUnified(db, serviceName);

  metricsCache.set(serviceName, {
    uptime7d: up7,
    uptime30d: up30,
    history: buckets,
    cachedAtMs: Date.now(),
  });

  return [up7, up30, buckets];
}

// Ported from extensions.go invalidateServiceMetricsCache (~L1061-1065). Go
// calls this from ingestStatusEvent (main.go:1023) on every write so a
// fresh check is reflected immediately instead of waiting out the 15s TTL.
// The TS ingestStatusEvent (status/ingest.ts) predates this file and isn't
// in this task's file list, so it doesn't call this yet — see open
// questions in the task report.
export function invalidateServiceMetricsCache(serviceName: string): void {
  metricsCache.delete(serviceName);
}

// Ported from extensions.go countRecentIncidents (~L515-540): used by the
// Prometheus exporter (main.go:1471, out of this task's scope) for a plain
// per-service incident count, cheaper than handleGetIncidents' full list.
export function countRecentIncidents(db: Database.Database, name: string, since: Date): number {
  let events: RawEvent[];
  try {
    events = fetchEvents(db, name, since);
  } catch {
    return 0;
  }
  const prior = fetchLastEventBefore(db, name, since);
  const timeline = buildTimeline(prior, events, since);

  let count = 0;
  let inIncident = false;
  for (const seg of timeline) {
    if (isDown(seg.status)) {
      if (!inIncident) {
        count++;
        inIncident = true;
      }
    } else {
      inIncident = false;
    }
  }
  return count;
}
