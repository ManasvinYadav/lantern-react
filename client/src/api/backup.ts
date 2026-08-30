// GET /api/backup streams a VACUUM INTO snapshot with a Content-Disposition
// attachment header — the browser handles that natively via a plain
// `<a href={getBackupUrl()} download>`, so this deliberately does not
// fetch+blob it (see api/services.ts's exportServiceHistory for the pattern
// that does need to, because that response has no attachment-friendly link
// target on its own).
export function getBackupUrl(): string {
  return "/api/backup";
}
