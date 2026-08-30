// Ported from main.go loadConfig/getEnv/getEnvInt (~L51-131). Env vars
// relevant to webhooks/REST config arrive in Phase 3.
export interface Config {
  port: number;
  dbPath: string;
  retentionDays: number;

  authUser: string;
  authPass: string;
  authToken: string;
  authEnabled: boolean;

  dockerDiscovery: boolean;
  dockerPollSeconds: number;

  certWarnDays: number;
  certCriticalDays: number;

  frameAncestors: string;
  wsAllowedOrigins: string[];

  staleHours: number;

  // Not ported from Go (the original binary embeds its static assets
  // directly) — this rewrite splits client/server, so the production Docker
  // image points the server at the client's built dist/ directory. Empty
  // disables static serving (local `npm run dev`, where Vite's own dev
  // server serves the client instead).
  staticDir: string;
}

function getEnv(key: string, fallback: string): string {
  const value = process.env[key];
  return value && value !== "" ? value : fallback;
}

function getEnvInt(key: string, fallback: number): number {
  const value = process.env[key];
  if (value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

export function loadConfig(): Config {
  const authUser = process.env.LANTERN_AUTH_USER ?? "";
  const authPass = process.env.LANTERN_AUTH_PASS ?? "";
  const authToken = process.env.LANTERN_AUTH_TOKEN ?? "";

  // main.go:107-109 floors LANTERN_DOCKER_POLL_SECONDS at 10.
  let dockerPollSeconds = getEnvInt("LANTERN_DOCKER_POLL_SECONDS", 60);
  if (dockerPollSeconds < 10) dockerPollSeconds = 10;

  // main.go:114-131: negative cert days clamp to 0; critical > warn collapses
  // critical down to warn (both env-driven and this collapse are startup
  // side effects mirrored here rather than as Go's package-level globals).
  let certWarnDays = getEnvInt("LANTERN_CERT_WARN_DAYS", 30);
  let certCriticalDays = getEnvInt("LANTERN_CERT_CRITICAL_DAYS", 7);
  if (certWarnDays < 0) certWarnDays = 0;
  if (certCriticalDays < 0) certCriticalDays = 0;
  if (certCriticalDays > certWarnDays) certCriticalDays = certWarnDays;

  const wsOriginsRaw = process.env.LANTERN_WS_ALLOWED_ORIGINS ?? "";
  const wsAllowedOrigins = wsOriginsRaw
    .split(",")
    .map((o) => o.trim().toLowerCase())
    .filter((o) => o.length > 0);

  return {
    port: getEnvInt("LANTERN_PORT", 7654),
    dbPath: getEnv("LANTERN_DB_PATH", "/data/lantern.db"),
    retentionDays: getEnvInt("LANTERN_RETENTION_DAYS", 30),

    authUser,
    authPass,
    authToken,
    authEnabled: authUser !== "", // main.go:105

    dockerDiscovery: process.env.LANTERN_DOCKER_DISCOVERY !== "false", // main.go:98
    dockerPollSeconds,

    certWarnDays,
    certCriticalDays,

    frameAncestors: getEnv("LANTERN_FRAME_ANCESTORS", ""),
    wsAllowedOrigins,

    // main.go:54,72 (LANTERN_STALE_HOURS, default 24).
    staleHours: getEnvInt("LANTERN_STALE_HOURS", 24),

    staticDir: getEnv("LANTERN_STATIC_DIR", ""),
  };
}
