import bcrypt from "bcryptjs";
import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { BCRYPT_COST } from "./constants.js";
import { constantTimeEquals } from "./timing.js";

// Ported from auth.go (~L82-121). credentialsPresent mirrors the Go
// atomic.Bool cache of "does an admin_credentials row exist", so read
// paths that gate on authRequired() don't hit the DB on every request.
let credentialsPresent = false;

export function authRequired(): boolean {
  return credentialsPresent;
}

export function refreshCredentialState(db: Database.Database): void {
  const row = db.prepare("SELECT 1 FROM admin_credentials WHERE id = 1").get();
  credentialsPresent = row !== undefined;
}

export async function writeCredentials(
  db: Database.Database,
  username: string,
  password: string
): Promise<void> {
  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const updatedAt = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO admin_credentials (id, username, password_hash, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET username = excluded.username, password_hash = excluded.password_hash, updated_at = excluded.updated_at`
  ).run(username, passwordHash, updatedAt);
  refreshCredentialState(db);
}

export function loadCredentials(db: Database.Database): { username: string } | null {
  const row = db.prepare("SELECT username FROM admin_credentials WHERE id = 1").get() as
    | { username: string }
    | undefined;
  return row ?? null;
}

// Ported from auth.go verifyCredentials (~L148-156): the username is
// compared in constant time and the password ALWAYS runs through bcrypt —
// both booleans are computed unconditionally before combining them — so a
// wrong username costs exactly as much as a wrong password. Short-
// circuiting on username mismatch would leak which usernames exist via
// response timing (native string compare vs. a ~50ms bcrypt round trip).
export async function verifyCredentials(
  db: Database.Database,
  username: string,
  password: string
): Promise<boolean> {
  const row = db
    .prepare("SELECT username, password_hash FROM admin_credentials WHERE id = 1")
    .get() as { username: string; password_hash: string } | undefined;
  if (!row) return false;
  const usernameOk = constantTimeEquals(username, row.username);
  const passwordOk = await bcrypt.compare(password, row.password_hash);
  return usernameOk && passwordOk;
}

// Ported from auth.go initAuth (~L94-113): env vars only seed the DB row on
// first boot, when the table is still empty. Once seeded, the DB row is
// authoritative — a credential change made via the UI is not silently
// reverted by a stale env var on the next restart.
export async function seedCredentialsFromEnv(db: Database.Database, cfg: Config): Promise<void> {
  refreshCredentialState(db);
  if (credentialsPresent) return;
  if (cfg.authUser === "" || cfg.authPass === "") return;
  await writeCredentials(db, cfg.authUser, cfg.authPass);
}
