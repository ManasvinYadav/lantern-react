import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.js";
import { AUTH_SCHEMA, CORE_SCHEMA, FEATURE_SCHEMA } from "./schema.js";
import { runMigrations } from "./migrations.js";

// Ported from main.go initDB (~L156-315). better-sqlite3 is a single
// synchronous connection, so Go's connection-pool tuning
// (SetMaxOpenConns/SetMaxIdleConns/SetConnMaxLifetime) has no equivalent
// here — that concern is specific to database/sql's pooled-connection model
// and doesn't apply to better-sqlite3.
export function openDatabase(cfg: Config): Database.Database {
  mkdirSync(dirname(cfg.dbPath), { recursive: true });

  const db = new Database(cfg.dbPath);

  // journal_mode is persisted in the database file header, so this only
  // needs to run once regardless of process restarts.
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  db.exec(CORE_SCHEMA);
  db.exec(FEATURE_SCHEMA);
  runMigrations(db);
  db.exec(AUTH_SCHEMA);

  return db;
}
