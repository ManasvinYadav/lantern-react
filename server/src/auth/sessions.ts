import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME, SESSION_TOKEN_BYTES, SESSION_TTL_MS } from "./constants.js";
import { hashToken } from "./hash.js";

// Ported from auth.go createSession (~L171-186): crypto/rand, 32 raw bytes
// (256 bits), hex-encoded. The raw value is only ever handed back to the
// caller to become the cookie value — never stored.
export function createSession(
  db: Database.Database,
  username: string
): { raw: string; expiresAtMs: number } {
  const raw = randomBytes(SESSION_TOKEN_BYTES).toString("hex");
  const now = Date.now();
  const expiresAtMs = now + SESSION_TTL_MS;
  db.prepare(
    "INSERT INTO sessions (token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(hashToken(raw), username, Math.floor(now / 1000), Math.floor(expiresAtMs / 1000));
  return { raw, expiresAtMs };
}

// Ported from auth.go sessionUser (~L188-203): enforced on every request,
// not just at login. An expired row is lazily deleted the moment it's next
// presented, independent of the hourly purge sweep.
export function sessionUser(db: Database.Database, rawToken: string): string | null {
  const tokenHash = hashToken(rawToken);
  const row = db
    .prepare("SELECT username, expires_at FROM sessions WHERE token_hash = ?")
    .get(tokenHash) as { username: string; expires_at: number } | undefined;
  if (!row) return null;
  if (Math.floor(Date.now() / 1000) > row.expires_at) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    return null;
  }
  return row.username;
}

export function revokeSession(db: Database.Database, rawToken: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(rawToken));
}

export function revokeAllSessions(db: Database.Database): void {
  db.prepare("DELETE FROM sessions").run();
}

// Ported from auth.go requestIsTLS (~L224-230): true if the socket itself
// is TLS, or a reverse proxy declared it terminated TLS on our behalf.
export function requestIsTLS(request: FastifyRequest): boolean {
  if ((request.raw.socket as { encrypted?: boolean }).encrypted) return true;
  const proto = request.headers["x-forwarded-proto"];
  const value = Array.isArray(proto) ? proto[0] : proto;
  return (value ?? "").toLowerCase() === "https";
}

// Ported from auth.go setSessionCookie (~L233-246). SameSite=Strict is the
// CSRF defense (CORS elsewhere is AllowedOrigins:["*"] with
// AllowCredentials:false); Secure only when the request itself arrived over
// TLS or behind a proxy that declared it did, so the cookie still works over
// plain HTTP on a bare LAN address.
export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  raw: string,
  expiresAtMs: number
): void {
  reply.setCookie(SESSION_COOKIE_NAME, raw, {
    path: "/",
    expires: new Date(expiresAtMs),
    httpOnly: true,
    sameSite: "strict",
    secure: requestIsTLS(request),
  });
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.setCookie(SESSION_COOKIE_NAME, "", {
    path: "/",
    maxAge: -1,
    httpOnly: true,
    sameSite: "strict",
    secure: requestIsTLS(request),
  });
}
