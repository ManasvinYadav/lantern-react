import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { ingestStatusEvent, type IngestHooks } from "../status/ingest.js";

interface LatestStatusRow {
  service_name: string;
  status: string;
  timestamp: string;
}

// Ported from main.go runStaleChecker (~L883-910), started from main() at
// L2013 as an always-running background loop. Every minute, finds each
// service's latest status_events row and — unless the service is in
// maintenance or that row is already "down"/"stale" — marks it "down" via
// ingestStatusEvent (so the usual dampening/webhook/broadcast path in
// IngestHooks fires exactly as for any other status change) once the row is
// older than cfg.staleHours. A failed query or per-service failure is
// swallowed and the ticker just waits for its next tick, matching Go's
// `continue` on query error and its ignored ingestStatusEvent return value.
export function startStaleChecker(
  db: Database.Database,
  cfg: Config,
  hooks: IngestHooks
): NodeJS.Timeout {
  return setInterval(() => {
    let rows: LatestStatusRow[];
    try {
      rows = db
        .prepare(
          `SELECT service_name, status, timestamp
           FROM status_events
           WHERE id IN (SELECT MAX(id) FROM status_events GROUP BY service_name)`
        )
        .all() as LatestStatusRow[];
    } catch (err) {
      console.error(`stale checker: query failed: ${err}`);
      return;
    }

    for (const row of rows) {
      const maintRow = db
        .prepare("SELECT enabled FROM service_maintenance WHERE service_name = ?")
        .get(row.service_name) as { enabled: number } | undefined;
      const maint = maintRow?.enabled ?? 0;
      if (maint === 1 || row.status === "down" || row.status === "stale") continue;

      const parsed = new Date(row.timestamp);
      if (Number.isNaN(parsed.getTime())) continue;

      const hoursSince = (Date.now() - parsed.getTime()) / (1000 * 60 * 60);
      if (hoursSince > cfg.staleHours) {
        try {
          ingestStatusEvent(
            db,
            row.service_name,
            "down",
            "Service missed heartbeat timeout",
            new Date(),
            0,
            hooks
          );
        } catch (err) {
          console.error(`stale checker: failed to mark ${row.service_name} down: ${err}`);
        }
      }
    }
  }, 60 * 1000);
}
