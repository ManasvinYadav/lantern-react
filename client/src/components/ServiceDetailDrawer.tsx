// Service detail drawer — a glass-strong side panel opened from the (not yet
// built) grid/list/command-palette, showing everything about one service
// beyond what its card already renders: group assignment, maintenance mode,
// Docker controls (source === "docker" only), latency stats, an uptime
// trend chart, container/host metadata, and history export.
//
// Controlled component: `serviceName` (null = closed) is the only signal of
// visibility. Everything else is fetched here — the caller only needs to
// know a name, never a full ServiceSummary.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "../api/http.ts";
import {
  exportServiceHistory,
  getServiceHistory,
  getServiceMetadata,
  getServiceUptime,
  listServices,
  setServiceGroup,
} from "../api/services.ts";
import { getMaintenance, setMaintenance } from "../api/maintenance.ts";
import { getDockerStatus, getDockerLogs, restartContainer } from "../api/docker.ts";
import type {
  DockerStatusResponse,
  MaintenanceState,
  ServiceMetadata,
  ServiceSummary,
  StatusEvent,
  UptimeDatapoint,
  UptimeRange,
} from "../api/types.ts";


export interface ServiceDetailDrawerProps {
  /** Service to show detail for; null closes the drawer. */
  serviceName: string | null;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Small local icons — same 20x20 stroke style as App.tsx's inline icon set.
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function IconClose({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

function IconRestart({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M16.5 10a6.5 6.5 0 1 1-2.1-4.8" />
      <path d="M16.5 3.5v3.6h-3.6" />
    </svg>
  );
}

function IconTerminal({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="1.5" />
      <path d="M5.5 8l3 2.5-3 2.5M10 13h4" />
    </svg>
  );
}

function IconDownload({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M10 3v9.5M6.2 9l3.8 3.8L13.8 9" />
      <path d="M3.5 15.5h13" />
    </svg>
  );
}

function IconCheck({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function errMessage(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

function formatRelative(iso: string | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diffSec = Math.max(0, (Date.now() - t) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatUnixSeconds(sec: number): string {
  if (!sec) return "—";
  return formatDateTime(new Date(sec * 1000).toISOString());
}

function sourceBadgeLabel(monitorType: string, source: string): string {
  if (monitorType) return monitorType.toUpperCase();
  if (source === "docker") return "Docker";
  if (source === "host") return "Host";
  return source ? source : "Unknown";
}

interface StatusVisual {
  dot: string;
  text: string;
  bg: string;
  border: string;
  label: string;
}

function statusVisual(status: string | undefined): StatusVisual {
  switch (status) {
    case "up":
      return { dot: "bg-up", text: "text-up", bg: "bg-up-bg", border: "border-up/30", label: "UP" };
    case "down":
      return { dot: "bg-down", text: "text-down", bg: "bg-down-bg", border: "border-down/30", label: "DOWN" };
    case "degraded":
      return { dot: "bg-degraded", text: "text-degraded", bg: "bg-degraded-bg", border: "border-degraded/30", label: "DEGRADED" };
    default:
      return {
        dot: "bg-unknown",
        text: "text-unknown",
        bg: "bg-unknown-bg",
        border: "border-unknown/30",
        label: status ? status.toUpperCase() : "UNKNOWN",
      };
  }
}

// ---------------------------------------------------------------------------
// Small reusable pieces
// ---------------------------------------------------------------------------

function Chip({ tone, children }: { tone: "up" | "down" | "degraded" | "maint" | "unknown"; children: ReactNode }) {
  const cls: Record<typeof tone, string> = {
    up: "border-up/30 bg-up-bg text-up",
    down: "border-down/30 bg-down-bg text-down",
    degraded: "border-degraded/30 bg-degraded-bg text-degraded",
    maint: "border-maint/30 bg-maint-bg text-maint",
    unknown: "border-unknown/30 bg-unknown-bg text-unknown",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cls[tone]}`}>
      {children}
    </span>
  );
}

function SectionHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{children}</h3>
      {action}
    </div>
  );
}

function StatTile({ label, value, sublabel }: { label: string; value: string; sublabel?: string }) {
  return (
    <div className="glass-subtle flex flex-col gap-0.5 px-3 py-2.5">
      <span className="text-[10px] uppercase tracking-wide text-text-muted">{label}</span>
      <span className="font-mono text-lg font-semibold tabular-nums text-text-primary">{value}</span>
      {sublabel && <span className="truncate text-[10px] text-text-muted">{sublabel}</span>}
    </div>
  );
}

function SkeletonTile() {
  return <div className="glass-subtle h-[58px] animate-shimmer" aria-hidden="true" />;
}

const inputClass =
  "w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text-primary outline-none transition-colors duration-[var(--duration-fast)] ease-out placeholder:text-text-muted focus:border-border-focus disabled:opacity-50";

const primaryBtnClass =
  "inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-transform duration-[var(--duration-fast)] ease-out active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50";

const ghostBtnClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";

const dangerBtnClass =
  "inline-flex items-center gap-1.5 rounded-md bg-down px-3 py-1.5 text-xs font-medium text-white transition-transform duration-[var(--duration-fast)] ease-out active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50";

// ---------------------------------------------------------------------------
// Uptime trend chart — hand-rolled CSS bars over ServiceUptimeResponse's
// datapoints, no charting dependency.
// ---------------------------------------------------------------------------

const UPTIME_RANGES: { value: UptimeRange; label: string }[] = [
  { value: "1h", label: "1h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

function RangeTabs({ value, onChange }: { value: UptimeRange; onChange: (r: UptimeRange) => void }) {
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-panel-bg/60 p-0.5" role="group" aria-label="Uptime range">
      {UPTIME_RANGES.map((r) => (
        <button
          key={r.value}
          type="button"
          onClick={() => onChange(r.value)}
          aria-pressed={value === r.value}
          className={`rounded px-2.5 py-1 text-xs font-medium transition-colors duration-[var(--duration-fast)] ease-out ${
            value === r.value ? "bg-accent text-white" : "text-text-secondary hover:bg-panel-hover hover:text-text-primary"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function UptimeChart({ datapoints }: { datapoints: UptimeDatapoint[] }) {
  if (datapoints.length === 0) {
    return <p className="text-sm text-text-muted">No data for this range yet.</p>;
  }
  return (
    <div className="flex h-20 items-end gap-[2px]" role="img" aria-label="Uptime over time">
      {datapoints.map((dp, i) => {
        const pct = Math.max(0, Math.min(100, dp.uptime_pct));
        const heightPct = Math.max(6, pct);
        const color = pct >= 99.5 ? "bg-up" : pct >= 95 ? "bg-degraded" : "bg-down";
        return (
          <div
            key={`${dp.timestamp}-${i}`}
            className={`min-w-[2px] flex-1 rounded-[1px] ${color} opacity-80 transition-[height] duration-300 ease-out hover:opacity-100`}
            style={{ height: `${heightPct}%` }}
            title={`${formatDateTime(dp.timestamp)} — ${pct.toFixed(1)}% uptime`}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type RestartState = "idle" | "confirm" | "pending" | "done" | "error";
type MetadataStatus = "idle" | "loading" | "ok" | "not-found" | "error";

interface LatencyStats {
  min: number;
  max: number;
  avg: number;
  count: number;
}

export function ServiceDetailDrawer({ serviceName, onClose }: ServiceDetailDrawerProps) {
  const groupInputId = useId();
  const noteInputId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  // Entrance transition: off-screen on first paint, slides in once mounted —
  // see the report for why this is a plain CSS transition rather than the
  // shared `animate-banner-in` keyframe (that one's a vertical fade, this is
  // a horizontal slide-in-from-right that matches a side drawer better).
  const [entered, setEntered] = useState(false);

  // Header / identity — the only place `source` (Docker-section gating) and
  // live status/message/group come from, since the drawer is handed just a
  // name, not a ServiceSummary.
  const [summary, setSummary] = useState<ServiceSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);

  // Group assignment.
  const [groupDraft, setGroupDraft] = useState("");
  const [groupSaving, setGroupSaving] = useState(false);
  const [groupSaveError, setGroupSaveError] = useState<string | null>(null);
  const [groupSaved, setGroupSaved] = useState(false);
  const groupSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Maintenance mode.
  const [maintenance, setMaintenanceRecord] = useState<MaintenanceState | null>(null);
  const [maintenanceToggling, setMaintenanceToggling] = useState(false);
  const [maintenanceToggleError, setMaintenanceToggleError] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSaveError, setNoteSaveError] = useState<string | null>(null);

  // Docker controls.
  const [dockerStatus, setDockerStatus] = useState<DockerStatusResponse | null>(null);
  const [dockerLoading, setDockerLoading] = useState(false);
  const [restartState, setRestartState] = useState<RestartState>("idle");
  const [restartError, setRestartError] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  // Latency stats.
  const [latencyStats, setLatencyStats] = useState<LatencyStats | null>(null);
  const [latencyLoading, setLatencyLoading] = useState(false);

  // Uptime trend.
  const [uptimeRange, setUptimeRange] = useState<UptimeRange>("24h");
  const [uptimeData, setUptimeData] = useState<{ pct: number; downtimeMin: number; incidents: number; datapoints: UptimeDatapoint[] } | null>(null);
  const [uptimeLoading, setUptimeLoading] = useState(false);

  // Metadata.
  const [metadata, setMetadata] = useState<ServiceMetadata | null>(null);
  const [metadataStatus, setMetadataStatus] = useState<MetadataStatus>("idle");

  // Export.
  const [exportError, setExportError] = useState<string | null>(null);

  // ---- Entrance transition + Escape-to-close + scroll lock ----
  useEffect(() => {
    if (!serviceName) {
      setEntered(false);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    panelRef.current?.focus();
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", handleKey);
    };
  }, [serviceName, onClose]);

  // ---- Reset + fetch: summary, maintenance, metadata, latency ----
  useEffect(() => {
    if (!serviceName) return;
    let cancelled = false;

    setSummary(null);
    setSummaryLoading(true);
    setGroupSaveError(null);
    setGroupSaved(false);
    setMaintenanceRecord(null);
    setMaintenanceToggleError(null);
    setNoteSaveError(null);
    setDockerStatus(null);
    setRestartState("idle");
    setRestartError(null);
    setLogsOpen(false);
    setLogs(null);
    setLogsError(null);
    setLatencyStats(null);
    setMetadata(null);
    setMetadataStatus("loading");
    setExportError(null);

    listServices()
      .then((all) => {
        if (cancelled) return;
        const match = (all as ServiceSummary[]).find((s) => s.service_name === serviceName) ?? null;
        setSummary(match);
        setGroupDraft(match?.group_name ?? "");
      })
      .catch((err: unknown) => {
        console.error("Failed to load service summary:", err);
      })
      .finally(() => {
        if (!cancelled) setSummaryLoading(false);
      });

    getMaintenance(serviceName)
      .then((m) => {
        if (cancelled) return;
        setMaintenanceRecord(m);
        setNoteDraft(m.note);
      })
      .catch((err: unknown) => {
        console.error("Failed to load maintenance state:", err);
      });

    getServiceMetadata(serviceName)
      .then((m) => {
        if (cancelled) return;
        setMetadata(m);
        setMetadataStatus("ok");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // 404 is the normal case for a push-only service with no active
        // monitor / no Docker match — omit the section quietly rather than
        // surfacing it as an error (see YOUR JOB: "handle a 404 gracefully").
        setMetadataStatus(err instanceof ApiError && err.status === 404 ? "not-found" : "error");
      });

    setLatencyLoading(true);
    getServiceHistory(serviceName, { limit: 100 })
      .then((res) => {
        if (cancelled) return;
        const events = res.events as StatusEvent[];
        const samples = events.map((e) => e.latency_ms).filter((v): v is number => typeof v === "number" && v > 0);
        if (samples.length === 0) {
          setLatencyStats({ min: 0, max: 0, avg: 0, count: 0 });
          return;
        }
        const min = Math.min(...samples);
        const max = Math.max(...samples);
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        setLatencyStats({ min, max, avg, count: samples.length });
      })
      .catch((err: unknown) => {
        console.error("Failed to load service history for latency stats:", err);
      })
      .finally(() => {
        if (!cancelled) setLatencyLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [serviceName]);

  // ---- Docker status: only once `summary.source` resolves to "docker" ----
  useEffect(() => {
    if (!serviceName || summary?.source !== "docker") return;
    let cancelled = false;
    setDockerLoading(true);
    getDockerStatus(serviceName)
      .then((d) => {
        if (!cancelled) setDockerStatus(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setDockerStatus({ available: false, message: errMessage(err) });
      })
      .finally(() => {
        if (!cancelled) setDockerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serviceName, summary?.source]);

  // ---- Uptime trend: refetches on range change ----
  useEffect(() => {
    if (!serviceName) return;
    let cancelled = false;
    setUptimeLoading(true);
    getServiceUptime(serviceName, uptimeRange)
      .then((d) => {
        if (cancelled) return;
        setUptimeData({ pct: d.uptime_pct, downtimeMin: d.total_downtime_minutes, incidents: d.total_incidents, datapoints: d.datapoints });
      })
      .catch((err: unknown) => {
        console.error("Failed to load uptime trend:", err);
        if (!cancelled) setUptimeData(null);
      })
      .finally(() => {
        if (!cancelled) setUptimeLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [serviceName, uptimeRange]);

  // ---- Docker logs: fetched on demand, refetchable ----
  const loadLogs = useCallback(() => {
    if (!serviceName) return;
    setLogsLoading(true);
    setLogsError(null);
    getDockerLogs(serviceName, 200)
      .then((res) => setLogs(res.logs))
      .catch((err: unknown) => setLogsError(errMessage(err)))
      .finally(() => setLogsLoading(false));
  }, [serviceName]);

  useEffect(() => {
    if (logsOpen) loadLogs();
  }, [logsOpen, loadLogs]);

  useEffect(() => {
    return () => {
      if (groupSavedTimer.current) clearTimeout(groupSavedTimer.current);
    };
  }, []);

  // ---- Handlers ----

  async function handleSaveGroup() {
    if (!serviceName || groupSaving) return;
    setGroupSaving(true);
    setGroupSaveError(null);
    try {
      const res = await setServiceGroup(serviceName, groupDraft.trim());
      setSummary((prev) => (prev ? { ...prev, group_name: res.group_name } : prev));
      setGroupDraft(res.group_name);
      setGroupSaved(true);
      if (groupSavedTimer.current) clearTimeout(groupSavedTimer.current);
      groupSavedTimer.current = setTimeout(() => setGroupSaved(false), 2000);
    } catch (err) {
      setGroupSaveError(errMessage(err));
    } finally {
      setGroupSaving(false);
    }
  }

  async function handleToggleMaintenance() {
    if (!serviceName || !maintenance || maintenanceToggling) return;
    const next = !maintenance.enabled;
    setMaintenanceToggling(true);
    setMaintenanceToggleError(null);
    try {
      const updated = await setMaintenance(serviceName, next, maintenance.note);
      setMaintenanceRecord(updated);
    } catch (err) {
      setMaintenanceToggleError(errMessage(err));
    } finally {
      setMaintenanceToggling(false);
    }
  }

  async function handleSaveNote() {
    if (!serviceName || !maintenance || noteSaving) return;
    setNoteSaving(true);
    setNoteSaveError(null);
    try {
      const updated = await setMaintenance(serviceName, maintenance.enabled, noteDraft);
      setMaintenanceRecord(updated);
    } catch (err) {
      setNoteSaveError(errMessage(err));
    } finally {
      setNoteSaving(false);
    }
  }

  async function handleConfirmRestart() {
    if (!serviceName) return;
    setRestartState("pending");
    setRestartError(null);
    try {
      await restartContainer(serviceName);
      setRestartState("done");
      getDockerStatus(serviceName)
        .then(setDockerStatus)
        .catch(() => {});
      setTimeout(() => setRestartState("idle"), 3000);
    } catch (err) {
      setRestartState("error");
      setRestartError(errMessage(err));
    }
  }

  async function handleExport(format: "csv" | "json") {
    if (!serviceName) return;
    setExportError(null);
    try {
      const blob = await exportServiceHistory(serviceName, format);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${serviceName}-history.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setExportError(errMessage(err));
    }
  }

  if (!serviceName) return null;

  const visual = statusVisual(summary?.status);
  const badgeLabel = summary ? sourceBadgeLabel(summary.monitor_type, summary.source) : null;

  return (
    <div className="fixed inset-0 z-40" role="presentation">
      <div
        className={`absolute inset-0 bg-black/50 backdrop-blur-sm transition-opacity duration-[var(--duration-base)] ease-out ${
          entered ? "opacity-100" : "opacity-0"
        }`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${serviceName} details`}
        className={`glass-strong absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-hidden outline-none transition-transform duration-[var(--duration-base)] ease-out sm:max-w-xl ${
          entered ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* ---- Header ---- */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${visual.dot}`} aria-hidden="true" />
              <h2 className="truncate text-lg font-semibold text-text-primary">{serviceName}</h2>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${visual.bg} ${visual.border} ${visual.text}`}>
                {visual.label}
              </span>
              {badgeLabel && (
                <span className="rounded-full border border-border bg-panel-bg px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted">
                  {badgeLabel}
                </span>
              )}
              {summary?.stale && <Chip tone="degraded">Stale</Chip>}
              {summary?.maintenance && <Chip tone="maint">Maintenance</Chip>}
            </div>
            {summary?.message && <p className="mt-1.5 truncate text-sm text-text-secondary">{summary.message}</p>}
            <p className="mt-1 text-xs text-text-muted">
              {summaryLoading && !summary ? "Loading…" : `Last seen ${formatRelative(summary?.last_seen)}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover hover:text-text-primary"
          >
            <IconClose />
          </button>
        </div>

        {/* ---- Body ---- */}
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {/* Group assignment */}
          <section>
            <SectionHeading>Group</SectionHeading>
            <div className="flex items-center gap-2">
              <label htmlFor={groupInputId} className="sr-only">
                Group name
              </label>
              <input
                id={groupInputId}
                type="text"
                value={groupDraft}
                onChange={(e) => setGroupDraft(e.target.value)}
                placeholder="Ungrouped"
                disabled={groupSaving}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => void handleSaveGroup()}
                disabled={groupSaving || groupDraft === (summary?.group_name ?? "")}
                className={primaryBtnClass}
              >
                {groupSaving ? "Saving…" : groupSaved ? (
                  <>
                    <IconCheck /> Saved
                  </>
                ) : (
                  "Save"
                )}
              </button>
            </div>
            {groupSaveError && <p className="mt-1.5 text-xs text-down">{groupSaveError}</p>}
          </section>

          {/* Maintenance mode */}
          <section>
            <SectionHeading>Maintenance mode</SectionHeading>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm text-text-primary">{maintenance?.enabled ? "Enabled" : "Disabled"}</p>
                {maintenance?.updated_at && (
                  <p className="text-xs text-text-muted">Updated {formatRelative(maintenance.updated_at)}</p>
                )}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={maintenance?.enabled ?? false}
                onClick={() => void handleToggleMaintenance()}
                disabled={!maintenance || maintenanceToggling}
                className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-[var(--duration-fast)] ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
                  maintenance?.enabled ? "border-maint/40 bg-maint" : "border-border bg-panel-bg"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform duration-[var(--duration-fast)] ease-out ${
                    maintenance?.enabled ? "translate-x-[22px]" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
            {maintenanceToggleError && <p className="mt-1.5 text-xs text-down">{maintenanceToggleError}</p>}

            <div className="mt-3 flex items-center gap-2">
              <label htmlFor={noteInputId} className="sr-only">
                Maintenance note
              </label>
              <input
                id={noteInputId}
                type="text"
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
                placeholder="Optional note (e.g. reason, ETA)"
                disabled={!maintenance || noteSaving}
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => void handleSaveNote()}
                disabled={!maintenance || noteSaving || noteDraft === maintenance.note}
                className={ghostBtnClass}
              >
                {noteSaving ? "Saving…" : "Save note"}
              </button>
            </div>
            {noteSaveError && <p className="mt-1.5 text-xs text-down">{noteSaveError}</p>}
          </section>

          {/* Docker controls — source === "docker" only */}
          {summary?.source === "docker" && (
            <section>
              <SectionHeading>Docker</SectionHeading>
              {dockerLoading && !dockerStatus && (
                <div className="space-y-2">
                  <SkeletonTile />
                </div>
              )}
              {dockerStatus && (
                <div className="space-y-3">
                  {!dockerStatus.available && <p className="text-sm text-text-secondary">{dockerStatus.message}</p>}
                  {dockerStatus.available && !dockerStatus.detected && (
                    <p className="text-sm text-text-secondary">
                      {"error" in dockerStatus ? dockerStatus.error : dockerStatus.message}
                    </p>
                  )}
                  {dockerStatus.available && dockerStatus.detected && (
                    <>
                      <div className="glass-subtle grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-3 text-xs">
                        <div>
                          <p className="text-text-muted">Container</p>
                          <p className="truncate font-mono text-text-primary">{dockerStatus.container_name || dockerStatus.container_id}</p>
                        </div>
                        <div>
                          <p className="text-text-muted">State</p>
                          <p className="text-text-primary">{dockerStatus.status || dockerStatus.state}</p>
                        </div>
                        <div>
                          <p className="text-text-muted">Image</p>
                          <p className="truncate font-mono text-text-primary">{dockerStatus.image}</p>
                        </div>
                        <div>
                          <p className="text-text-muted">Created</p>
                          <p className="text-text-primary">{formatUnixSeconds(dockerStatus.created)}</p>
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {restartState === "idle" && (
                          <button type="button" onClick={() => setRestartState("confirm")} className={ghostBtnClass}>
                            <IconRestart /> Restart container
                          </button>
                        )}
                        {restartState === "confirm" && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-text-secondary">Restart this container?</span>
                            <button type="button" onClick={() => void handleConfirmRestart()} className={dangerBtnClass}>
                              Confirm
                            </button>
                            <button type="button" onClick={() => setRestartState("idle")} className={ghostBtnClass}>
                              Cancel
                            </button>
                          </div>
                        )}
                        {restartState === "pending" && (
                          <button type="button" disabled className={ghostBtnClass}>
                            Restarting…
                          </button>
                        )}
                        {restartState === "done" && <span className="text-xs text-up">Restart initiated.</span>}
                        {restartState === "error" && (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-down">{restartError}</span>
                            <button type="button" onClick={() => setRestartState("idle")} className="text-xs text-text-secondary underline">
                              Try again
                            </button>
                          </div>
                        )}

                        <button type="button" onClick={() => setLogsOpen((v) => !v)} className={ghostBtnClass}>
                          <IconTerminal /> {logsOpen ? "Hide logs" : "View logs"}
                        </button>
                      </div>

                      {logsOpen && (
                        <div className="glass-subtle overflow-hidden">
                          <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
                            <span className="text-[11px] uppercase tracking-wide text-text-muted">Recent logs</span>
                            <button
                              type="button"
                              onClick={loadLogs}
                              disabled={logsLoading}
                              className="text-[11px] text-text-secondary underline decoration-transparent underline-offset-2 hover:decoration-current disabled:opacity-50"
                            >
                              {logsLoading ? "Refreshing…" : "Refresh"}
                            </button>
                          </div>
                          <div className="max-h-56 overflow-y-auto px-3 py-2">
                            {logsLoading && !logs && <p className="text-xs text-text-muted">Loading logs…</p>}
                            {logsError && <p className="text-xs text-down">{logsError}</p>}
                            {!logsLoading && !logsError && (
                              <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-text-secondary">
                                {logs || "No log output."}
                              </pre>
                            )}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </section>
          )}

          {/* Latency stats */}
          <section>
            <SectionHeading>Latency</SectionHeading>
            {latencyLoading && (
              <div className="grid grid-cols-3 gap-2">
                <SkeletonTile />
                <SkeletonTile />
                <SkeletonTile />
              </div>
            )}
            {!latencyLoading && latencyStats && latencyStats.count === 0 && (
              <p className="text-sm text-text-muted">No recent latency samples recorded.</p>
            )}
            {!latencyLoading && latencyStats && latencyStats.count > 0 && (
              <div className="grid grid-cols-3 gap-2">
                <StatTile label="Min" value={`${Math.round(latencyStats.min)} ms`} />
                <StatTile label="Avg" value={`${Math.round(latencyStats.avg)} ms`} sublabel={`of ${latencyStats.count} recent checks`} />
                <StatTile label="Max" value={`${Math.round(latencyStats.max)} ms`} />
              </div>
            )}
          </section>

          {/* Uptime trend */}
          <section>
            <SectionHeading action={<RangeTabs value={uptimeRange} onChange={setUptimeRange} />}>Uptime trend</SectionHeading>
            {uptimeLoading && !uptimeData && <div className="h-20 animate-shimmer rounded-md bg-panel-bg" />}
            {uptimeData && (
              <div className="space-y-3">
                <div className="grid grid-cols-3 gap-2">
                  <StatTile label="Uptime" value={`${uptimeData.pct.toFixed(2)}%`} />
                  <StatTile label="Downtime" value={`${uptimeData.downtimeMin.toFixed(1)}m`} />
                  <StatTile label="Incidents" value={String(uptimeData.incidents)} />
                </div>
                <UptimeChart datapoints={uptimeData.datapoints} />
              </div>
            )}
          </section>

          {/* Metadata — omitted entirely on 404 (push-only service, no active
              monitor) or any other fetch failure, per the task's "handle a
              404 gracefully" instruction. */}
          {metadataStatus === "loading" && (
            <section>
              <SectionHeading>Metadata</SectionHeading>
              <SkeletonTile />
            </section>
          )}
          {metadataStatus === "ok" && metadata && (
            <section>
              <SectionHeading>Metadata</SectionHeading>
              <div className="glass-subtle grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-3 text-xs">
                <div>
                  <p className="text-text-muted">Type</p>
                  <p className="text-text-primary">{metadata.type}</p>
                </div>
                <div>
                  <p className="text-text-muted">Events recorded</p>
                  <p className="text-text-primary">{metadata.total_events_recorded}</p>
                </div>
                {metadata.image && (
                  <div>
                    <p className="text-text-muted">Image</p>
                    <p className="truncate font-mono text-text-primary">{metadata.image}</p>
                  </div>
                )}
                {metadata.ip_address && (
                  <div>
                    <p className="text-text-muted">IP address</p>
                    <p className="font-mono text-text-primary">{metadata.ip_address}</p>
                  </div>
                )}
                {metadata.health_status && (
                  <div>
                    <p className="text-text-muted">Health</p>
                    <p className="text-text-primary">{metadata.health_status}</p>
                  </div>
                )}
                {metadata.restart_count !== undefined && (
                  <div>
                    <p className="text-text-muted">Restarts</p>
                    <p className="text-text-primary">{metadata.restart_count}</p>
                  </div>
                )}
                {metadata.started_at && (
                  <div>
                    <p className="text-text-muted">Started</p>
                    <p className="text-text-primary">{formatDateTime(metadata.started_at)}</p>
                  </div>
                )}
              </div>
              {metadata.ports && metadata.ports.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {metadata.ports.map((p, i) => (
                    <span key={i} className="rounded border border-border bg-panel-bg px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">
                      {p.container_port}/{p.type}
                      {p.host_port ? ` → ${p.host_port}` : ""}
                    </span>
                  ))}
                </div>
              )}
              {metadata.mounts && metadata.mounts.length > 0 && (
                <div className="mt-2 space-y-1">
                  {metadata.mounts.map((m, i) => (
                    <p key={i} className="truncate font-mono text-[10px] text-text-muted">
                      {m.source} → {m.destination} {m.rw ? "(rw)" : "(ro)"}
                    </p>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Export */}
          <section>
            <SectionHeading>Export history</SectionHeading>
            <div className="flex gap-2">
              <button type="button" onClick={() => void handleExport("csv")} className={ghostBtnClass}>
                <IconDownload /> CSV
              </button>
              <button type="button" onClick={() => void handleExport("json")} className={ghostBtnClass}>
                <IconDownload /> JSON
              </button>
            </div>
            {exportError && <p className="mt-1.5 text-xs text-down">{exportError}</p>}
          </section>
        </div>
      </aside>
    </div>
  );
}
