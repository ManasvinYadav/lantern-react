// Ported 1:1 from origin/master main.go (~L194-289) and features.go (~L19-34)
// and auth.go (~L53-66) of the Go Lantern codebase (commit 2bc748c, v0.62.2).
// No foreign keys exist in the original — all referential integrity is
// app-layer only (matching TEXT service_name values). Preserved as-is.

export const CORE_SCHEMA = `
CREATE TABLE IF NOT EXISTS status_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    service_name TEXT    NOT NULL,
    status       TEXT    NOT NULL,
    message      TEXT,
    timestamp    DATETIME NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_status_service
    ON status_events(service_name, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_status_events_service_id
    ON status_events(service_name, id DESC);

CREATE INDEX IF NOT EXISTS idx_status_events_service_ts
    ON status_events(service_name, timestamp ASC);

CREATE INDEX IF NOT EXISTS idx_status_svc_time
    ON status_events(service_name, timestamp DESC, id DESC);

CREATE TABLE IF NOT EXISTS diagnostic_runs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    service_name TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    content      TEXT    NOT NULL,
    timestamp    DATETIME NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_diag_service
    ON diagnostic_runs(service_name, timestamp DESC);

CREATE TABLE IF NOT EXISTS service_maintenance (
    service_name TEXT PRIMARY KEY,
    enabled      INTEGER NOT NULL DEFAULT 0,
    note         TEXT,
    updated_at   DATETIME
);

CREATE TABLE IF NOT EXISTS maintenance_windows (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    service_name TEXT NOT NULL,
    started_at   DATETIME NOT NULL,
    ended_at     DATETIME,
    note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_maint_windows_service
    ON maintenance_windows(service_name, started_at);

CREATE TABLE IF NOT EXISTS api_tokens (
    token TEXT PRIMARY KEY,
    service_name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_configs (
    channel    TEXT PRIMARY KEY,
    url        TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_groups (
    service_name TEXT PRIMARY KEY,
    group_name   TEXT NOT NULL DEFAULT '',
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    channel      TEXT    NOT NULL,
    service_name TEXT    NOT NULL,
    old_status   TEXT,
    new_status   TEXT,
    success      INTEGER NOT NULL DEFAULT 0,
    http_status  INTEGER,
    error        TEXT,
    created_at   DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_created
    ON webhook_deliveries(created_at DESC);

CREATE TABLE IF NOT EXISTS active_monitors (
    service_name     TEXT PRIMARY KEY,
    monitor_type     TEXT NOT NULL,
    target           TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL DEFAULT 60,
    enabled          INTEGER NOT NULL DEFAULT 1,
    last_checked_at  DATETIME,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// features.go featureSchema
export const FEATURE_SCHEMA = `
CREATE TABLE IF NOT EXISTS incident_banners (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    level        TEXT     NOT NULL,
    title        TEXT     NOT NULL,
    body         TEXT     NOT NULL DEFAULT '',
    created_at   DATETIME NOT NULL,
    dismissed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_banners_active
    ON incident_banners(dismissed_at, id DESC);

CREATE TABLE IF NOT EXISTS service_alert_routes (
    service_name TEXT PRIMARY KEY,
    channels     TEXT     NOT NULL DEFAULT '',
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// auth.go authSchema
export const AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_credentials (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    username      TEXT    NOT NULL,
    password_hash TEXT    NOT NULL,
    updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT    PRIMARY KEY,
    username   TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires
    ON sessions(expires_at);
`;
