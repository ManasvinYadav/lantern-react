import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { countRecentIncidents, getCachedOrComputeServiceMetrics } from "../metrics/compute.js";

// Ported from main.go: const version = "0.5.0" (~L31).
const VERSION = "0.5.0";

interface ApiDocRoute {
  method: string;
  path: string;
  desc: string;
  example: string;
}

interface ApiDocSection {
  title: string;
  routes: ApiDocRoute[];
}

// Ported verbatim from extensions.go apiDocSections (~L726-793) — hand
// maintained alongside the real route table in Go, transcribed as-is here.
const API_DOC_SECTIONS: ApiDocSection[] = [
  {
    title: "Authentication",
    routes: [
      {
        method: "—",
        path: "—",
        desc: "Bearer token: Authorization: Bearer <LANTERN_AUTH_TOKEN> (admin) or a per-service token from api_tokens (scoped). Basic Auth: LANTERN_AUTH_USER/LANTERN_AUTH_PASS. Required only on mutating/admin routes once either is configured — see docs/CONFIG.md.",
        example: "",
      },
    ],
  },
  {
    title: "Health & Meta",
    routes: [
      { method: "GET", path: "/api/health", desc: "Service health and version, always open.", example: "" },
      {
        method: "GET",
        path: "/metrics",
        desc: "Prometheus text-format metrics, always open.",
        example: "curl http://localhost:7654/metrics",
      },
      { method: "GET", path: "/api/docs", desc: "This page.", example: "" },
    ],
  },
  {
    title: "Status Ingestion",
    routes: [
      {
        method: "POST",
        path: "/api/status",
        desc: "Report a service's status. Requires auth once configured.",
        example: `curl -X POST /api/status -d '{"service_name":"db","status":"up","message":"ok","maintenance":false}'`,
      },
    ],
  },
  {
    title: "Services",
    routes: [
      {
        method: "GET",
        path: "/api/services",
        desc: "Latest status, uptime %, 30-day history, group, and monitor type for every service.",
        example: "",
      },
      {
        method: "GET",
        path: "/api/services/{name}/history?limit=&offset=",
        desc: "Raw status_events for one service. limit capped at 500.",
        example: "",
      },
      {
        method: "GET",
        path: "/api/services/{name}/export?format=csv|json",
        desc: "Download a service's full status history.",
        example: "",
      },
      {
        method: "PUT",
        path: "/api/services/{name}/group",
        desc: "Assign a service to a group. Requires auth once configured.",
        example: `curl -X PUT /api/services/db/group -d '{"group":"data"}'`,
      },
      {
        method: "GET",
        path: "/api/services/{name}/metadata",
        desc: "Container/host metadata (ports, image, IP) plus Lantern telemetry.",
        example: "",
      },
      {
        method: "GET",
        path: "/api/services/{name}/uptime?range=1h|24h|7d|30d",
        desc: "Uptime %, downtime, incident count, and graph datapoints.",
        example: "",
      },
      {
        method: "GET",
        path: "/api/services/{name}/strip?hours=",
        desc: "Bucketed status history for the trend bar (max 96 buckets).",
        example: "",
      },
      {
        method: "GET",
        path: "/api/services/{name}/incidents?range=",
        desc: "Detected down/degraded incidents with duration.",
        example: "",
      },
    ],
  },
  {
    title: "Groups",
    routes: [{ method: "GET", path: "/api/groups", desc: "Every group name and its service count.", example: "" }],
  },
  {
    title: "Maintenance",
    routes: [
      {
        method: "GET",
        path: "/api/services/{name}/maintenance",
        desc: "Current maintenance state for a service.",
        example: "",
      },
      {
        method: "PUT",
        path: "/api/services/{name}/maintenance",
        desc: "Enable/disable maintenance mode. Requires auth once configured.",
        example: `curl -X PUT /api/services/db/maintenance -d '{"enabled":true,"note":"upgrade"}'`,
      },
    ],
  },
  {
    title: "Active Monitoring",
    routes: [
      {
        method: "GET",
        path: "/api/monitors",
        desc: "Every configured active monitor across all services.",
        example: "",
      },
      {
        method: "GET",
        path: "/api/services/{name}/monitor",
        desc: "Active monitor config for one service (404 if none).",
        example: "",
      },
      {
        method: "PUT",
        path: "/api/services/{name}/monitor",
        desc: "Create/update an active monitor. Requires auth once configured.",
        example: `curl -X PUT /api/services/db/monitor -d '{"monitor_type":"tcp","target":"db:5432","interval_seconds":60}'`,
      },
      {
        method: "DELETE",
        path: "/api/services/{name}/monitor",
        desc: "Remove an active monitor (service reverts to push-only). Requires auth once configured.",
        example: "",
      },
    ],
  },
  {
    title: "Diagnostics",
    routes: [
      {
        method: "POST",
        path: "/api/diagnostics",
        desc: "Attach a diagnostic run (log dump, debug output) to a service. Requires auth once configured.",
        example: "",
      },
      {
        method: "GET",
        path: "/api/diagnostics?service_name=&limit=&offset=",
        desc: "List diagnostic runs, optionally filtered. limit capped at 500.",
        example: "",
      },
      {
        method: "GET",
        path: "/api/diagnostics/{id}",
        desc: "Full content of one diagnostic run.",
        example: "",
      },
    ],
  },
  {
    title: "Activity",
    routes: [
      {
        method: "GET",
        path: "/api/activity?limit=",
        desc: "Merged, timestamp-sorted feed of status changes and webhook deliveries across all services.",
        example: "",
      },
    ],
  },
  {
    title: "Webhooks",
    routes: [
      {
        method: "GET",
        path: "/api/webhooks",
        desc: "Configured webhook URLs per channel and their source (db/env/none).",
        example: "",
      },
      {
        method: "PUT",
        path: "/api/webhooks",
        desc: "Save webhook URL(s). Requires auth once configured.",
        example: `curl -X PUT /api/webhooks -d '{"discord":"https://discord.com/api/webhooks/..."}'`,
      },
      {
        method: "POST",
        path: "/api/webhooks/test",
        desc: "Send a test message to one or all configured channels. Requires auth once configured.",
        example: `curl -X POST /api/webhooks/test -d '{"channel":"discord"}'`,
      },
      {
        method: "GET",
        path: "/api/webhooks/deliveries?limit=",
        desc: "Recent delivery attempts (success/failure) across all channels.",
        example: "",
      },
    ],
  },
  {
    title: "Docker Management",
    routes: [
      {
        method: "GET",
        path: "/api/services/{name}/docker/status",
        desc: "Whether a matching container was found and its current state. Requires auth once configured.",
        example: "",
      },
      {
        method: "POST",
        path: "/api/services/{name}/docker/restart",
        desc: "Restart the matching container. Requires auth once configured.",
        example: "",
      },
      {
        method: "GET",
        path: "/api/services/{name}/docker/logs?tail=",
        desc: "Recent container logs (tail capped at 1000 lines). Requires auth once configured.",
        example: "",
      },
    ],
  },
  {
    title: "Backup",
    routes: [
      {
        method: "GET",
        path: "/api/backup",
        desc: "Download a consistent database snapshot (VACUUM INTO). See docs/BACKUP.md for restore steps.",
        example: "",
      },
    ],
  },
  {
    title: "Real-time",
    routes: [
      {
        method: "WS",
        path: "/ws",
        desc: 'WebSocket: broadcasts {type:"status_update", service:{...}} on every status change. Same auth as the rest of the app.',
        example: "",
      },
    ],
  },
  {
    title: "Public (always unauthenticated)",
    routes: [
      {
        method: "GET",
        path: "/api/public/services",
        desc: "Same shape as /api/services — powers the public /status page.",
        example: "",
      },
      { method: "GET", path: "/api/public/groups", desc: "Same shape as /api/groups.", example: "" },
      {
        method: "GET",
        path: "/api/public/services/{name}/metadata",
        desc: "Same shape as the private metadata endpoint.",
        example: "",
      },
      {
        method: "GET",
        path: "/api/public/services/{name}/uptime",
        desc: "Same shape as the private uptime endpoint.",
        example: "",
      },
      { method: "WS", path: "/api/public/ws", desc: "WebSocket for the public status page — no auth, ever.", example: "" },
    ],
  },
];

// Ported from extensions.go htmlEscape (~L840-845): only the three
// characters that matter when splicing apiDocSections' hand-written text
// into the docs page's HTML.
function htmlEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Ported from extensions.go handleDocs (~L795-836). Despite living under
// the Go /api subrouter's jsonMiddleware, this handler overrides
// Content-Type to text/html — the response is a rendered HTML page, not
// JSON (this task's brief describes it as JSON serialization; the actual
// Go source does not do that — see open questions).
function renderDocsHtml(): string {
  let b = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Lantern API Reference</title>
<style>
  :root { color-scheme: dark; }
  body { background:#0a0d14; color:#f8fafc; font-family:-apple-system,BlinkMacSystemFont,'Inter',sans-serif; margin:0; padding:32px 24px 80px; line-height:1.5; }
  .wrap { max-width:900px; margin:0 auto; }
  h1 { font-size:24px; margin-bottom:4px; }
  .sub { color:#94a3b8; font-size:13px; margin-bottom:36px; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:0.5px; color:#94a3b8; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:8px; margin:36px 0 12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  td { padding:8px 10px; vertical-align:top; border-bottom:1px solid rgba(255,255,255,0.06); }
  td.method { font-family:'JetBrains Mono',Consolas,monospace; font-weight:600; white-space:nowrap; width:70px; }
  td.path { font-family:'JetBrains Mono',Consolas,monospace; color:#f8fafc; white-space:nowrap; }
  td.desc { color:#94a3b8; }
  .m-GET { color:#10b981; } .m-POST { color:#f59e0b; } .m-PUT { color:#60a5fa; } .m-DELETE { color:#f43f5e; } .m-WS { color:#8b5cf6; }
  pre { background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:6px; padding:8px 10px; margin-top:4px; font-size:11px; color:#94a3b8; overflow-x:auto; }
</style></head><body><div class="wrap">
<h1>Lantern API Reference</h1>
<div class="sub">Generated from the live route table. See docs/API.md, docs/CONFIG.md, and docs/WEBHOOKS.md for more detail.</div>`;

  for (const section of API_DOC_SECTIONS) {
    b += `<h2>${htmlEscape(section.title)}</h2><table><tbody>`;
    for (const route of section.routes) {
      const example = route.example !== "" ? `<pre>${htmlEscape(route.example)}</pre>` : "";
      b += `<tr><td class="method m-${htmlEscape(route.method)}">${htmlEscape(route.method)}</td><td class="path">${htmlEscape(route.path)}</td><td class="desc">${htmlEscape(route.desc)}${example}</td></tr>`;
    }
    b += "</tbody></table>";
  }

  b += "</div></body></html>";
  return b;
}

// Approximates Go's %q (strconv.Quote) for the label values used in the
// Prometheus exporter: escapes backslash/quote/control characters. Go's
// exact rune-printability rules for non-ASCII text are not replicated.
function goQuote(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else out += ch;
  }
  out += '"';
  return out;
}

interface ServiceStatusRow {
  service_name: string;
  status: string;
  group_name: string;
}

// Ported from main.go handleHealth/handleDocs/handlePrometheusMetrics
// (~L1410-1417, extensions.go ~L795-836, main.go ~L1423-1477).
export async function registerMetaRoutes(app: FastifyInstance, db: Database.Database) {
  app.get("/api/health", async (_request, reply) => {
    reply.send({ status: "ok", version: VERSION });
  });

  app.get("/api/docs", async (_request, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.send(renderDocsHtml());
  });

  // Registered outside /api and outside the JSON body — plain text
  // Prometheus exposition format, exempt from auth like /api/public/*.
  app.get("/metrics", async (_request, reply) => {
    let rows: ServiceStatusRow[];
    try {
      rows = db
        .prepare(
          `SELECT s.service_name as service_name, s.status as status, COALESCE(g.group_name, '') as group_name
FROM status_events s
LEFT JOIN service_groups g ON s.service_name = g.service_name
WHERE s.id IN (SELECT MAX(id) FROM status_events GROUP BY service_name)
ORDER BY s.service_name ASC`
        )
        .all() as ServiceStatusRow[];
    } catch (err) {
      app.log.error(err, "handlePrometheusMetrics db error");
      // Go uses http.Error here (plain text), not the JSON writeError
      // helper the rest of the API uses.
      reply.code(500).type("text/plain; charset=utf-8").send("database error\n");
      return;
    }

    let b = "";
    b += "# HELP lantern_service_status Current status of the service (1 = up, 0 = not up)\n";
    b += "# TYPE lantern_service_status gauge\n";
    for (const s of rows) {
      const val = s.status === "up" ? 1 : 0;
      b += `lantern_service_status{service=${goQuote(s.service_name)},group=${goQuote(s.group_name)}} ${val}\n`;
    }

    b += "# HELP lantern_service_uptime_ratio Uptime ratio (0-1) over the given range\n";
    b += "# TYPE lantern_service_uptime_ratio gauge\n";
    for (const s of rows) {
      const [up7, up30] = getCachedOrComputeServiceMetrics(db, s.service_name);
      b += `lantern_service_uptime_ratio{service=${goQuote(s.service_name)},range="7d"} ${(up7 / 100).toFixed(4)}\n`;
      b += `lantern_service_uptime_ratio{service=${goQuote(s.service_name)},range="30d"} ${(up30 / 100).toFixed(4)}\n`;
    }

    b += "# HELP lantern_incident_count Distinct down/degraded incidents in the last 30 days\n";
    b += "# TYPE lantern_incident_count gauge\n";
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    for (const s of rows) {
      const count = countRecentIncidents(db, s.service_name, since30d);
      b += `lantern_incident_count{service=${goQuote(s.service_name)}} ${count}\n`;
    }

    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    reply.send(b);
  });
}
