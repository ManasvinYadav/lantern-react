// Shared response/request types for every Lantern REST endpoint. Field names
// and optionality are copied verbatim from the server's TS route/service
// files (server/src/routes/*.ts, server/src/services/summary.ts,
// server/src/metrics/compute.ts) rather than imported, since the client
// can't reach across the package boundary — see this file's sibling modules
// for which endpoint returns which type.

// ---------------------------------------------------------------------------
// Services (server/src/services/summary.ts, server/src/metrics/compute.ts)
// ---------------------------------------------------------------------------

/** "empty" is a left-padding placeholder (not a real check) used to keep the
 * heartbeat bar a fixed length for services with fewer recorded checks than
 * the requested limit — render it as a blank/dim slot, not a status. */
export interface HeartbeatBeat {
  status: string;
  timestamp: string;
  msg: string;
  latency_ms: number;
}

export interface ServiceSummary {
  service_name: string;
  status: string;
  message: string;
  timestamp: string;
  last_seen: string;
  stale: boolean;
  maintenance: boolean;
  group_name: string;
  uptime_7d: number;
  uptime_30d: number;
  uptime_percent: number;
  history: HeartbeatBeat[];
  monitor_type: string;
  // Derived server-side: "monitor" | "docker" | "host" — see
  // server/src/services/summary.ts serviceSource.
  source: string;
}

export interface StatusEvent {
  id: number;
  status: string;
  message: string;
  timestamp: string;
  latency_ms: number;
}

export interface ServiceHistoryResponse {
  service_name: string;
  events: StatusEvent[];
}

export interface SetServiceGroupResponse {
  status: "ok";
  service_name: string;
  group_name: string;
}

// ---------------------------------------------------------------------------
// Groups (server/src/routes/groups.ts)
// ---------------------------------------------------------------------------

export interface GroupSummary {
  name: string;
  count: number;
}

// ---------------------------------------------------------------------------
// Uptime / strip / incidents (server/src/routes/uptime.ts)
// ---------------------------------------------------------------------------

export type UptimeRange = "1h" | "24h" | "7d" | "30d";

export interface UptimeDatapoint {
  timestamp: string;
  uptime_pct: number;
}

export interface ServiceUptimeResponse {
  service_name: string;
  range: string;
  uptime_pct: number;
  total_downtime_minutes: number;
  total_incidents: number;
  datapoints: UptimeDatapoint[];
}

export interface StatusBucket {
  start: string;
  status: string;
}

export interface ServiceStripResponse {
  service_name: string;
  hours: number;
  buckets: StatusBucket[];
}

export interface Incident {
  started_at: string;
  /** Empty string when the incident is still ongoing at the end of the window. */
  ended_at: string;
  duration_minutes: number;
  trigger_status: string;
  trigger_message: string;
  in_maintenance: boolean;
}

export interface ServiceIncidentsResponse {
  service_name: string;
  range: string;
  total_downtime_minutes: number;
  incidents: Incident[];
}

// ---------------------------------------------------------------------------
// Maintenance (server/src/routes/maintenance.ts)
// ---------------------------------------------------------------------------

export interface MaintenanceState {
  service_name: string;
  enabled: boolean;
  note: string;
  /** Empty string when maintenance has never been toggled for this service. */
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Active monitors (server/src/routes/monitors.ts)
// ---------------------------------------------------------------------------

export type MonitorType = "http" | "tcp" | "ping";

export interface ActiveMonitor {
  service_name: string;
  monitor_type: string;
  target: string;
  interval_seconds: number;
  enabled: boolean;
  last_checked_at: string | null;
  cert_expiry_at: string | null;
  cert_days_remaining: number | null;
  cert_warning: boolean;
}

export interface SetServiceMonitorRequest {
  monitor_type: MonitorType;
  target: string;
  interval_seconds?: number;
  enabled?: boolean;
}

export interface DeleteServiceMonitorResponse {
  status: "ok";
  service_name: string;
}

// ---------------------------------------------------------------------------
// Docker (server/src/routes/docker.ts)
// ---------------------------------------------------------------------------

/** Docker socket not reachable at all — every other field below is absent. */
export interface DockerStatusUnavailable {
  available: false;
  message: string;
}

/** Socket reachable but the container search itself failed. */
export interface DockerStatusSearchError {
  available: true;
  detected: false;
  error: string;
}

/** Socket reachable, search succeeded, no matching container. */
export interface DockerStatusNotDetected {
  available: true;
  detected: false;
  message: string;
}

export interface DockerStatusDetected {
  available: true;
  detected: true;
  container_id: string;
  container_name: string;
  image: string;
  state: string;
  status: string;
  /** Unix timestamp (seconds), as returned by the Docker Engine API. */
  created: number;
}

export type DockerStatusResponse =
  | DockerStatusUnavailable
  | DockerStatusSearchError
  | DockerStatusNotDetected
  | DockerStatusDetected;

export interface DockerRestartResponse {
  status: "ok";
  message: string;
  container_id: string;
}

export interface DockerLogsResponse {
  status: "ok";
  service_name: string;
  container_id: string;
  container_name: string;
  tail: number;
  logs: string;
}

export interface DockerPortBinding {
  container_port: number;
  type: string;
  host_port?: string;
  host_ip?: string;
}

export interface DockerMount {
  type: string;
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
}

// Every field past docker_detected carries the server's `omitempty` — absent
// from the JSON entirely (not sent as ""/0/null/[]) when Docker wasn't
// detected or the corresponding inspect field was empty. Only optional here,
// never nullable, to match that.
export interface ServiceMetadata {
  service_name: string;
  group_name: string;
  type: "host" | "docker";
  docker_detected: boolean;
  container_id?: string;
  container_name?: string;
  image?: string;
  state?: string;
  created_at?: string;
  started_at?: string;
  restart_count?: number;
  health_status?: string;
  ip_address?: string;
  network_name?: string;
  ports?: DockerPortBinding[];
  mounts?: DockerMount[];
  total_events_recorded: number;
  last_seen: string;
  maintenance_enabled: boolean;
}

// ---------------------------------------------------------------------------
// Diagnostics (server/src/routes/diagnostics.ts)
// ---------------------------------------------------------------------------

export interface PostDiagnosticRequest {
  service_name: string;
  title: string;
  content: string;
  /** RFC 3339 timestamp; omit to default to "now" server-side. */
  timestamp?: string;
}

export interface PostDiagnosticResponse {
  id: number;
}

export interface DiagnosticRunSummary {
  id: number;
  service_name: string;
  title: string;
  timestamp: string;
  created_at: string;
}

export interface DiagnosticRunDetail extends DiagnosticRunSummary {
  content: string;
}

// ---------------------------------------------------------------------------
// Activity (server/src/routes/activity.ts)
// ---------------------------------------------------------------------------

export interface ActivityEvent {
  type: "status_change" | "webhook_delivery";
  service_name: string;
  status?: string;
  message?: string;
  channel?: string;
  success?: boolean;
  http_status?: number;
  error?: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Webhooks (server/src/routes/webhooks.ts, server/src/webhooks/dispatcher.ts)
// ---------------------------------------------------------------------------

export type WebhookChannel = "discord" | "telegram" | "gotify" | "generic";

export interface WebhookChannelConfig {
  configured: boolean;
  url: string;
  /** Where the configured URL came from: "db" | "env" | "none". */
  source: string;
}

export type WebhooksResponse = Record<WebhookChannel, WebhookChannelConfig>;

/** Single-channel form; the multi-channel form is a `Record<string, string>`
 * mapping channel name -> URL (empty URL deletes that channel's config). */
export interface SetWebhookRequest {
  channel: WebhookChannel;
  url: string;
}

export type SetWebhooksRequest = SetWebhookRequest | Record<string, string>;

export interface SetWebhooksResponse {
  status: "ok";
  message: string;
}

/** Channel has no URL configured anywhere (db/env) — never attempted. */
export interface WebhookTestSkipped {
  attempted: false;
  source: "none";
  message: string;
}

/** Transport-level failure (request never got an HTTP response). */
export interface WebhookTestTransportFailure {
  attempted: true;
  success: false;
  source: string;
  message: string;
}

/** Request completed; success reflects whether the endpoint accepted it. */
export interface WebhookTestCompleted {
  attempted: true;
  success: boolean;
  source: string;
  status_code: number;
}

export type WebhookTestResult = WebhookTestSkipped | WebhookTestTransportFailure | WebhookTestCompleted;

export interface TestWebhookResponse {
  status: "ok";
  results: Partial<Record<WebhookChannel, WebhookTestResult>>;
}

export interface WebhookDelivery {
  id: number;
  channel: string;
  service_name: string;
  old_status: string;
  new_status: string;
  success: boolean;
  http_status: number;
  error: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Auth (server/src/auth/routes.ts)
// ---------------------------------------------------------------------------

export interface AuthSession {
  auth_required: boolean;
  authenticated: boolean;
  /** Only present when `authenticated` is true. */
  username?: string;
  token_mode: boolean;
  can_setup: boolean;
}

export interface LoginResponse {
  authenticated: true;
  username: string;
}

export interface LogoutResponse {
  authenticated: false;
}

export interface SetupCredentialsRequest {
  current_password?: string;
  new_username?: string;
  new_password?: string;
}

export interface SetupCredentialsResponse {
  updated: true;
  username: string;
  reauth: false;
}
