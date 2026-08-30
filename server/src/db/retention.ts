import type Database from "better-sqlite3";
import type { Config } from "../config.js";

// Ported from main.go cleanupRetention/runRetentionCleanup (~L336-365).
// Sessions ride the same sweep on their own fixed 30-day TTL, independent
// of RetentionDays, matching the Go comment: "there is only one scheduled
// sweep."
export function cleanupRetention(db: Database.Database, cfg: Config): void {
  const cutoff = `-${cfg.retentionDays} days`;

  db.prepare("DELETE FROM status_events WHERE timestamp < datetime('now', ?)").run(cutoff);
  db.prepare("DELETE FROM diagnostic_runs WHERE timestamp < datetime('now', ?)").run(cutoff);
  // Only prune completed windows (ended_at set); a still-active window
  // (ended_at IS NULL) must never be deleted regardless of how long ago it
  // started.
  db.prepare(
    "DELETE FROM maintenance_windows WHERE ended_at IS NOT NULL AND ended_at < datetime('now', ?)"
  ).run(cutoff);

  purgeExpiredSessions(db);
}

export function purgeExpiredSessions(db: Database.Database): void {
  const nowEpochSeconds = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowEpochSeconds);
}

export function startRetentionTicker(db: Database.Database, cfg: Config): NodeJS.Timeout {
  return setInterval(() => {
    cleanupRetention(db, cfg);
    console.log(`retention cleanup complete (keeping ${cfg.retentionDays} days)`);
  }, 60 * 60 * 1000);
}
