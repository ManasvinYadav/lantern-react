import type Database from "better-sqlite3";
import { invalidateServiceMetricsCache } from "../metrics/compute.js";

// Ported from main.go fetchPrevTwoStatuses (~L2253-2265). Ordered by id
// (insertion order), not timestamp — dampening reasons about the checks
// actually observed, so a backfilled timestamp must not reshuffle the
// alert decision. Returns (prev1, prev2): most recent first, "" if missing.
export function fetchPrevTwoStatuses(
  db: Database.Database,
  serviceName: string
): { prev1: string; prev2: string } {
  const rows = db
    .prepare("SELECT status FROM status_events WHERE service_name = ? ORDER BY id DESC LIMIT 2")
    .all(serviceName) as { status: string }[];
  return {
    prev1: rows[0]?.status ?? "",
    prev2: rows[1]?.status ?? "",
  };
}

// Ported verbatim from main.go shouldNotify (~L2215-2246): requires two
// consecutive "down" reads before announcing an outage, and two
// consecutive non-"down" reads before announcing recovery. A single-check
// flap (up -> down -> up) is fully visible in status_events/uptime math
// immediately, but produces zero webhook notifications.
export function shouldNotify(
  prev2: string,
  prev1: string,
  current: string
): { fire: boolean; reason: "down" | "recovery" | "change" | "" } {
  if (prev1 === "") return { fire: false, reason: "" };

  if (current === "down") {
    if (prev1 === "down" && prev2 !== "down") return { fire: true, reason: "down" };
    return { fire: false, reason: "" };
  }
  if (prev1 === "down") {
    if (prev2 === "down") return { fire: true, reason: "recovery" };
    return { fire: false, reason: "" };
  }
  if (prev1 !== current) return { fire: true, reason: "change" };
  return { fire: false, reason: "" };
}

export interface IngestHooks {
  // Phase 3 fills these in: webhook dispatch and websocket broadcast. Left
  // as no-op stubs here so discovery/monitors can write real data now
  // without depending on subsystems that don't exist yet.
  onNotify?: (serviceName: string, prevStatus: string, status: string, message: string) => void;
  onWrite?: (serviceName: string) => void;
}

// Ported from main.go ingestStatusEvent (~L1300-1326): the single write
// path for every status change, whether it arrives via POST /api/status
// (Phase 3), Docker discovery, or an active monitor check. All three land
// in the same status_events table, so uptime %, incidents, and the history
// graph work identically regardless of origin.
export function ingestStatusEvent(
  db: Database.Database,
  serviceName: string,
  status: string,
  message: string,
  timestamp: Date,
  latencyMs: number,
  hooks: IngestHooks = {}
): number {
  const { prev1, prev2 } = fetchPrevTwoStatuses(db, serviceName);

  const result = db
    .prepare(
      "INSERT INTO status_events (service_name, status, message, timestamp, latency_ms) VALUES (?, ?, ?, ?, ?)"
    )
    .run(serviceName, status, message, timestamp.toISOString(), latencyMs);

  // main.go:1023 invalidates the uptime cache on every write so the next
  // request sees the new event immediately, instead of waiting out the
  // cache's TTL.
  invalidateServiceMetricsCache(serviceName);

  const maintenanceRow = db
    .prepare("SELECT enabled FROM service_maintenance WHERE service_name = ?")
    .get(serviceName) as { enabled: number } | undefined;
  const inMaintenance = (maintenanceRow?.enabled ?? 0) !== 0;

  if (!inMaintenance) {
    const { fire } = shouldNotify(prev2, prev1, status);
    if (fire) {
      hooks.onNotify?.(serviceName, prev1, status, message);
    }
  }

  hooks.onWrite?.(serviceName);

  return Number(result.lastInsertRowid);
}
