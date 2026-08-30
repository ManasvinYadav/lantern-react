import type { FastifyRequest } from "fastify";
import { MAX_LOGIN_FAILURES, LOGIN_LOCKOUT_MS, THROTTLE_ENTRY_TTL_MS } from "./constants.js";

// Ported from auth.go loginThrottle (~L303-392). In-memory, keyed by
// RemoteAddr host only — deliberately NOT X-Forwarded-For, since that
// header is attacker-controlled.
interface ThrottleEntry {
  failures: number;
  until: number; // epoch ms; 0 means not locked
  lastSeen: number;
}

const entries = new Map<string, ThrottleEntry>();

function sweepLocked(now: number): void {
  for (const [key, entry] of entries) {
    // An active lockout is never evicted by staleness alone — only
    // isBlocked()'s own elapsed-lockout check clears it. Otherwise a large
    // THROTTLE_ENTRY_TTL_MS/LOGIN_LOCKOUT_MS gap change later could let a
    // stale-looking-but-still-locked entry get swept mid-lockout.
    if (entry.until > now) continue;
    if (now - entry.lastSeen > THROTTLE_ENTRY_TTL_MS) {
      entries.delete(key);
    }
  }
}

export function throttleKey(request: FastifyRequest): string {
  const remoteAddress = request.socket.remoteAddress ?? request.ip;
  // net.SplitHostPort semantics: strip a trailing ":<port>" for IPv4/hostname
  // addresses; leave bracketed IPv6 alone if no port suffix is present.
  const match = remoteAddress.match(/^(.*):(\d+)$/);
  if (match && !remoteAddress.startsWith("[")) {
    return match[1];
  }
  return remoteAddress;
}

export function isBlocked(key: string): { blocked: boolean; waitMs: number } {
  const now = Date.now();
  const entry = entries.get(key);
  if (!entry || entry.until === 0) {
    return { blocked: false, waitMs: 0 };
  }
  const remaining = entry.until - now;
  if (remaining > 0) {
    return { blocked: true, waitMs: remaining };
  }
  // Lockout elapsed: reset so the next attempt starts from a clean slate.
  entries.delete(key);
  return { blocked: false, waitMs: 0 };
}

export function recordFailure(key: string): void {
  const now = Date.now();
  sweepLocked(now);
  const entry = entries.get(key) ?? { failures: 0, until: 0, lastSeen: now };
  entry.lastSeen = now;
  entry.failures += 1;
  if (entry.failures >= MAX_LOGIN_FAILURES) {
    entry.until = now + LOGIN_LOCKOUT_MS;
    entry.failures = 0;
  }
  entries.set(key, entry);
}

export function recordSuccess(key: string): void {
  entries.delete(key);
}
