// Ported from monitors.go certStatusFor/applyCertFields (~L54-66, 423-436).
export type CertStatus = "ok" | "warning" | "critical" | "expired";

export function certStatusFor(daysRemaining: number, certWarnDays: number, certCriticalDays: number): CertStatus {
  if (daysRemaining < 0) return "expired";
  if (daysRemaining <= certCriticalDays) return "critical";
  if (daysRemaining <= certWarnDays) return "warning";
  return "ok";
}

export interface CertFields {
  certExpiryAt: string | null;
  certDaysRemaining: number | null;
  certStatus: CertStatus | null;
  certWarning: boolean;
}

// Recomputed live from the stored cert_expiry_at timestamp and the current
// wall clock on every read — the status string itself is never stored.
export function applyCertFields(
  certExpiryAt: string | null,
  certWarnDays: number,
  certCriticalDays: number
): CertFields {
  if (!certExpiryAt) {
    return { certExpiryAt: null, certDaysRemaining: null, certStatus: null, certWarning: false };
  }
  const expiry = new Date(certExpiryAt);
  if (Number.isNaN(expiry.getTime())) {
    return { certExpiryAt, certDaysRemaining: null, certStatus: null, certWarning: false };
  }
  // Integer-truncating division of hours by 24, toward zero — matches Go's
  // int(time.Until(t).Hours() / 24) exactly (30.9 days reports 30, not 31).
  const hoursRemaining = (expiry.getTime() - Date.now()) / (1000 * 60 * 60);
  const daysRemaining = Math.trunc(hoursRemaining / 24);
  const status = certStatusFor(daysRemaining, certWarnDays, certCriticalDays);
  return {
    certExpiryAt,
    certDaysRemaining: daysRemaining,
    certStatus: status,
    certWarning: status !== "ok",
  };
}
