import { timingSafeEqual } from "node:crypto";

// Shared by middleware.ts (bearer token / Basic-Auth env compare) and
// credentials.ts (verifyCredentials' username compare) — extracted here to
// avoid a circular import between the two. Go's subtle.ConstantTimeCompare
// returns false for differing lengths without erroring; Node's
// crypto.timingSafeEqual throws on a length mismatch, so that case is
// guarded here rather than left to throw.
export function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
