import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { isDockerDiscovered } from "../docker/discovery.js";
import { fetchRecentBeats, getCachedOrComputeServiceMetrics } from "../metrics/compute.js";
import type { HeartbeatBeat } from "../metrics/compute.js";

export type { HeartbeatBeat };

// Ported from main.go ServiceSummary (~L397-413): the shape returned by one
// item of GET /api/services, and reused verbatim for WebSocket
// status_update broadcasts (main.go:589-592).
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
  // Source is where this service's status comes from: "monitor", "docker" or
  // "host". Derived, not stored — see serviceSource (docker.go:62).
  source: string;
}

// Ported from docker.go serviceSource (~L62-70).
function serviceSource(serviceName: string, monitorType: string): string {
  if (monitorType !== "") return "monitor";
  if (isDockerDiscovered(serviceName)) return "docker";
  return "host";
}

interface ServiceRow {
  service_name: string;
  status: string;
  message: string;
  timestamp: string;
  group_name: string;
  monitor_type: string;
}

// Ported from main.go buildServiceSummary (~L609-642): assembles the same
// shape GET /api/services returns, for one service. Returns null where the
// Go version returns (ServiceSummary{}, false) — no status_events row
// exists yet for this service name.
export function buildServiceSummary(db: Database.Database, cfg: Config, name: string): ServiceSummary | null {
  const row = db
    .prepare(
      `SELECT s.service_name AS service_name, s.status AS status, COALESCE(s.message,'') AS message,
              s.timestamp AS timestamp, COALESCE(g.group_name,'') AS group_name,
              COALESCE(m.monitor_type,'') AS monitor_type
       FROM status_events s
       LEFT JOIN service_groups g ON s.service_name = g.service_name
       LEFT JOIN active_monitors m ON s.service_name = m.service_name AND m.enabled = 1
       WHERE s.service_name = ?
       ORDER BY s.id DESC LIMIT 1`
    )
    .get(name) as ServiceRow | undefined;

  if (!row) return null;

  const timestamp = row.timestamp;
  let stale = false;
  const parsed = new Date(timestamp);
  if (!Number.isNaN(parsed.getTime())) {
    const hoursSince = (Date.now() - parsed.getTime()) / (1000 * 60 * 60);
    if (hoursSince > cfg.staleHours) stale = true;
  }

  const maintRow = db
    .prepare("SELECT enabled FROM service_maintenance WHERE service_name = ?")
    .get(name) as { enabled: number } | undefined;
  const maintenance = (maintRow?.enabled ?? 0) === 1;

  const [uptime7d, uptime30d] = getCachedOrComputeServiceMetrics(db, name);
  const history = fetchRecentBeats(db, name, 30);

  return {
    service_name: row.service_name,
    status: row.status,
    message: row.message,
    timestamp,
    last_seen: timestamp,
    stale,
    maintenance,
    group_name: row.group_name,
    uptime_7d: uptime7d,
    uptime_30d: uptime30d,
    uptime_percent: uptime30d,
    history,
    monitor_type: row.monitor_type,
    source: serviceSource(row.service_name, row.monitor_type),
  };
}
