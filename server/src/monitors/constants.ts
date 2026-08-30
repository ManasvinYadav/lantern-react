// Ported from monitors.go:1-31.
export const VALID_MONITOR_TYPES = new Set(["http", "tcp", "ping"]);
export const MIN_MONITOR_INTERVAL_SECONDS = 10;
export const MAX_MONITOR_INTERVAL_SECONDS = 3600;
export const MONITOR_CHECK_TIMEOUT_MS = 10_000;
export const MONITOR_QUEUE_SIZE = 256;
export const MONITOR_WORKER_COUNT = 4;
export const MAX_HTTP_REDIRECTS = 10;
