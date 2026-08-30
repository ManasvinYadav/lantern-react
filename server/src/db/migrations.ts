import type Database from "better-sqlite3";

// Ported from main.go applyMigration/L302-305. The Go version has no
// schema-version table: each ALTER TABLE is additive and re-run on every
// boot, relying on SQLite's "duplicate column name" error to detect a
// no-op. Same pattern here, so behavior matches exactly on a DB file
// shared between the Go and Node versions during cutover.
const MIGRATIONS = [
  "ALTER TABLE webhook_configs ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;",
  "ALTER TABLE active_monitors ADD COLUMN cert_expiry_at DATETIME;",
  "ALTER TABLE status_events ADD COLUMN latency_ms INTEGER DEFAULT 0;",
];

export function applyMigration(db: Database.Database, stmt: string): void {
  try {
    db.exec(stmt);
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : String(err);
    if (message.includes("duplicate column name")) {
      return;
    }
    console.error(`schema migration failed: ${err} (statement: ${stmt})`);
  }
}

export function runMigrations(db: Database.Database): void {
  for (const stmt of MIGRATIONS) {
    applyMigration(db, stmt);
  }
}
