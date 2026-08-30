import type Database from "better-sqlite3";
import { hashToken } from "./hash.js";

// Ported from auth.go lookupScopedToken (~L272-296). Per-service API tokens
// used to be stored plaintext; the security-hardening commit (8d7afd0)
// switched to hashed storage and upgrades any surviving plaintext row to
// its hash in place on first use, so a stolen DB backup yields no usable
// token going forward without breaking tokens minted before the upgrade.
export function lookupScopedToken(db: Database.Database, rawToken: string): string | null {
  const hashed = hashToken(rawToken);

  const byHash = db
    .prepare("SELECT service_name FROM api_tokens WHERE token = ?")
    .get(hashed) as { service_name: string } | undefined;
  if (byHash) return byHash.service_name;

  const byPlaintext = db
    .prepare("SELECT service_name FROM api_tokens WHERE token = ?")
    .get(rawToken) as { service_name: string } | undefined;
  if (byPlaintext) {
    db.prepare("UPDATE api_tokens SET token = ? WHERE token = ?").run(hashed, rawToken);
    return byPlaintext.service_name;
  }

  return null;
}
