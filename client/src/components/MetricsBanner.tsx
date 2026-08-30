// Metrics row (Overall Uptime / Active Incidents / Avg Response) and the
// outage-detected banner. Both are pure presentational components computed
// entirely client-side from the same `services: ServiceSummary[]` array
// `useLanternRealtime` already produces (see ../hooks/useLanternRealtime.ts)
// — no separate fetch, no server aggregate endpoint. There is no
// "announcements" or incident-authoring backend feature behind the banner;
// it's derived from the live services array on every render.
//
// `computeServiceMetrics` is the single source of truth for all three
// formulas — MetricsRow and OutageBanner both call it so nobody downstream
// recomputes these differently. See its doc comment for exact formulas.
import type { ReactNode } from "react";
import type { HeartbeatBeat, ServiceSummary } from "../api/types";

// ---------------------------------------------------------------------------
// api/types.ts (stable, out of scope to edit here) predates two backend
// fields that are already live: server/src/services/summary.ts's
// ServiceSummary.source and server/src/metrics/compute.ts's
// HeartbeatBeat.latency_ms (server/src/routes/services.ts:23 confirms the
// same field on the separate /history endpoint). Only latency_ms is needed
// here, read through a local intersection type instead of widening the
// shared client contract.
// ---------------------------------------------------------------------------
type BeatWithLatency = HeartbeatBeat & { latency_ms?: number };

function beatLatencyMs(beat: HeartbeatBeat): number {
  return (beat as BeatWithLatency).latency_ms ?? 0;
}

export interface ServiceMetrics {
  /** Mean of services[].uptime_percent. null when services is empty (never
   * a fabricated mean-of-zero). */
  overallUptimePct: number | null;
  /** Count of services[] with status === "down". */
  activeIncidents: number;
  totalServices: number;
  /** Mean latency_ms across every beat (flattened over every service's
   * history array) with status !== "empty" and latency_ms > 0. null when
   * avgResponseSampleCount is 0 — never a fabricated 0/NaN average. */
  avgResponseMs: number | null;
  /** The real N behind "Mean of N recent checks" — the count of beats the
   * avgResponseMs average above was actually taken over. */
  avgResponseSampleCount: number;
}

export function computeServiceMetrics(services: ServiceSummary[]): ServiceMetrics {
  const totalServices = services.length;

  const overallUptimePct =
    totalServices === 0 ? null : services.reduce((sum, s) => sum + s.uptime_percent, 0) / totalServices;

  const activeIncidents = services.filter((s) => s.status === "down").length;

  let latencySum = 0;
  let latencyCount = 0;
  for (const service of services) {
    for (const beat of service.history) {
      if (beat.status === "empty") continue;
      const latency = beatLatencyMs(beat);
      if (latency > 0) {
        latencySum += latency;
        latencyCount += 1;
      }
    }
  }
  const avgResponseMs = latencyCount === 0 ? null : latencySum / latencyCount;

  return {
    overallUptimePct,
    activeIncidents,
    totalServices,
    avgResponseMs,
    avgResponseSampleCount: latencyCount,
  };
}

function formatUptime(pct: number | null): string {
  return pct === null ? "—" : `${pct.toFixed(1)}%`;
}

function formatLatency(ms: number | null): string {
  return ms === null ? "—" : `${Math.round(ms)} ms`;
}

// ---------------------------------------------------------------------------
// Icons — same inline-stroke-SVG convention as App.tsx's header icons (no
// icon package dependency): 20x20 viewBox, currentColor stroke.
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function IconUptime({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.3" />
      <path d="M6.6 10.3 8.8 12.5 13.4 7.3" />
    </svg>
  );
}

function IconIncident({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="7.3" />
      <path d="M10 6.3v4.4" />
      <line x1="10" y1="13.5" x2="10" y2="13.53" />
    </svg>
  );
}

function IconLatency({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M11.2 2.5 4.6 11.6h4.1l-1.3 5.9 7-9.9h-4.3l1.1-5.1Z" strokeLinejoin="round" />
    </svg>
  );
}

function IconAlertTriangle({ className = "h-5 w-5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M10 3.1 18 16.6H2L10 3.1Z" strokeLinejoin="round" />
      <path d="M10 8.1v4" />
      <line x1="10" y1="14.5" x2="10" y2="14.53" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// MetricsRow — three tiles: Overall Uptime, Active Incidents, Avg Response.
// ---------------------------------------------------------------------------

function MetricTile({
  icon,
  label,
  value,
  valueClassName = "text-text-primary",
  caption,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
  caption?: string;
}) {
  return (
    <div className="glass flex flex-col gap-2 p-4">
      <div className="flex items-center gap-1.5 text-text-muted">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <div className={`text-2xl font-semibold tabular-nums ${valueClassName}`}>{value}</div>
      {caption && <div className="text-xs text-text-secondary">{caption}</div>}
    </div>
  );
}

export function MetricsRow({ services }: { services: ServiceSummary[] }) {
  const metrics = computeServiceMetrics(services);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Service metrics">
      <MetricTile icon={<IconUptime />} label="Overall Uptime" value={formatUptime(metrics.overallUptimePct)} />
      <MetricTile
        icon={<IconIncident />}
        label="Active Incidents"
        value={String(metrics.activeIncidents)}
        valueClassName={metrics.activeIncidents > 0 ? "text-down" : "text-text-primary"}
      />
      <MetricTile
        icon={<IconLatency />}
        label="Avg Response"
        value={formatLatency(metrics.avgResponseMs)}
        caption={
          metrics.avgResponseSampleCount > 0
            ? `Mean of ${metrics.avgResponseSampleCount} recent checks`
            : "No recent latency data"
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// OutageBanner — renders only when at least one service is down.
// ---------------------------------------------------------------------------

export function OutageBanner({ services }: { services: ServiceSummary[] }) {
  const metrics = computeServiceMetrics(services);
  if (metrics.activeIncidents === 0) return null;

  return (
    <div
      role="alert"
      className="glass animate-banner-in flex flex-wrap items-center gap-x-6 gap-y-3 border-down/30 bg-down-bg p-4 shadow-[0_0_40px_-12px_var(--color-down-glow)]"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-down/15 text-down">
          <IconAlertTriangle />
        </span>
        <div>
          <p className="text-sm font-semibold text-down">
            {metrics.activeIncidents} down of {metrics.totalServices} service{metrics.totalServices === 1 ? "" : "s"}
          </p>
          <p className="text-xs text-text-secondary">
            Active incident{metrics.activeIncidents === 1 ? "" : "s"} detected
          </p>
        </div>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-text-secondary">
        <span>
          Overall Uptime{" "}
          <span className="font-medium tabular-nums text-text-primary">{formatUptime(metrics.overallUptimePct)}</span>
        </span>
        <span>
          Avg Response{" "}
          <span className="font-medium tabular-nums text-text-primary">{formatLatency(metrics.avgResponseMs)}</span>
          {metrics.avgResponseSampleCount > 0 && (
            <span className="text-text-muted"> (n={metrics.avgResponseSampleCount})</span>
          )}
        </span>
      </div>
    </div>
  );
}
