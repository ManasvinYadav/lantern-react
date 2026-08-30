import { createHash } from "node:crypto";

// Ported from auth.go hashSessionToken (~L164-167). Plain unsalted SHA-256
// is safe here because the input is always a high-entropy random token
// (256-bit session token or scoped API token), never a low-entropy secret
// like a password — so no salt/slow-hash is needed. A stolen database
// yields no usable session or token, only its hash.
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
