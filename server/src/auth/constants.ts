// Ported from auth.go:40-49.
export const SESSION_COOKIE_NAME = "lantern_session";
export const SESSION_TOKEN_BYTES = 32; // 256 bits of crypto.randomBytes entropy
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // flat 30 days, no sliding refresh
export const BCRYPT_COST = 10; // bcrypt.DefaultCost — ~50ms on this class of hardware

export const MAX_LOGIN_FAILURES = 5;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
export const THROTTLE_ENTRY_TTL_MS = 2 * LOGIN_LOCKOUT_MS;
