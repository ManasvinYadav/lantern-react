// A single service's card, in both grid-tile and horizontal list-row
// presentations. Purely presentational + one callback out (onOpenDetail) —
// no data fetching, no grid/filtering/grouping logic, no drawer. Those are
// separate agents' jobs; this file is meant to be dropped into whatever
// container renders the working `services` array from useLanternRealtime.
import type { CSSProperties } from "react";
import type { HeartbeatBeat, ServiceSummary } from "../api/types.ts";

export interface ServiceCardProps {
  service: ServiceSummary;
  viewMode: "grid" | "list";
  /** Whether this service's name is currently in useLanternRealtime's
   * `justUpdated` Set (a status_update landed on it in the last ~1.2s) —
   * the caller does the `justUpdated.has(service.service_name)` lookup, this
   * component just wants the resulting boolean for this one card. */
  justUpdated?: boolean;
  /** Same idea for `justBeat` (a new heartbeat landed in the last ~400ms). */
  justBeat?: boolean;
  onOpenDetail: (serviceName: string) => void;
}

// ---------------------------------------------------------------------------
// Status metadata — literal Tailwind class strings (Tailwind's scanner needs
// the full class name to appear in source, not a `bg-${status}` template) so
// each status/maintenance state maps to the design system's semantic tokens.
// ---------------------------------------------------------------------------

interface StatusMeta {
  label: string;
  dot: string;
  text: string;
  chipBg: string;
  glowVar: string;
  pulseRing: boolean;
}

const STATUS_META: Record<string, StatusMeta> = {
  up: {
    label: "UP",
    dot: "bg-up",
    text: "text-up",
    chipBg: "bg-up-bg",
    glowVar: "var(--color-up-glow)",
    pulseRing: false,
  },
  down: {
    label: "DOWN",
    dot: "bg-down",
    text: "text-down",
    chipBg: "bg-down-bg",
    glowVar: "var(--color-down-glow)",
    pulseRing: true,
  },
  degraded: {
    label: "DEGRADED",
    dot: "bg-degraded",
    text: "text-degraded",
    chipBg: "bg-degraded-bg",
    glowVar: "var(--color-degraded-glow)",
    pulseRing: true,
  },
  unknown: {
    label: "UNKNOWN",
    dot: "bg-unknown",
    text: "text-unknown",
    chipBg: "bg-unknown-bg",
    glowVar: "var(--color-unknown-glow)",
    pulseRing: false,
  },
};

const MAINTENANCE_META: StatusMeta = {
  label: "MAINTENANCE",
  dot: "bg-maint",
  text: "text-maint",
  chipBg: "bg-maint-bg",
  glowVar: "var(--color-maint-glow)",
  pulseRing: false,
};

function statusMeta(service: ServiceSummary): StatusMeta {
  // Maintenance is a separate boolean on ServiceSummary, not a status value
  // (server/src/routes/status.ts VALID_STATUSES = up/down/degraded/unknown)
  // — a service in maintenance visually reads as "maintenance" regardless of
  // its underlying status, same as the maint color token existing for
  // exactly this purpose.
  if (service.maintenance) return MAINTENANCE_META;
  return STATUS_META[service.status] ?? STATUS_META.unknown;
}

function sourceBadgeLabel(service: ServiceSummary): string | null {
  const monitorType = service.monitor_type.trim();
  if (monitorType) return monitorType.toUpperCase();
  switch (service.source) {
    case "docker":
      return "Docker";
    case "host":
      return "Host";
    case "monitor":
      return "Monitor";
    default:
      return null;
  }
}

function beatSegmentClass(status: string): string {
  switch (status) {
    case "up":
      return "bg-up";
    case "down":
      return "bg-down";
    case "degraded":
      return "bg-degraded";
    case "empty":
      return "bg-border/60";
    default:
      return "bg-unknown";
  }
}

function beatTooltip(beat: HeartbeatBeat): string | undefined {
  if (beat.status === "empty" || !beat.timestamp) return undefined;
  const parsed = new Date(beat.timestamp);
  const timeLabel = Number.isNaN(parsed.getTime()) ? beat.timestamp : parsed.toLocaleString();
  const latencyLabel = beat.latency_ms > 0 ? `${beat.latency_ms}ms` : "no latency reported";
  const messageSuffix = beat.msg ? ` — ${beat.msg}` : "";
  return `${timeLabel} · ${beat.status} · ${latencyLabel}${messageSuffix}`;
}

function formatRelativeTime(iso: string): string {
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  const diffMonth = Math.floor(diffDay / 30);
  if (diffMonth < 12) return `${diffMonth}mo ago`;
  return `${Math.floor(diffMonth / 12)}y ago`;
}

// ---------------------------------------------------------------------------
// Small inline pieces
// ---------------------------------------------------------------------------

function IconChevronRight({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M7.5 4.5 13 10l-5.5 5.5" />
    </svg>
  );
}

function StatusDot({ meta }: { meta: StatusMeta }) {
  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
      {meta.pulseRing && <span className={`absolute inset-0 rounded-full ${meta.dot} animate-pulse-ring`} />}
      <span className={`relative inline-block h-2.5 w-2.5 rounded-full ${meta.dot}`} />
    </span>
  );
}

function HeartbeatBar({
  history,
  justBeat,
  className = "",
}: {
  history: HeartbeatBeat[];
  justBeat: boolean;
  className?: string;
}) {
  return (
    <div className={`flex h-6 items-end gap-[2px] ${className}`} role="img" aria-label="Recent status history, oldest to newest">
      {history.map((beat, i) => {
        const isLast = i === history.length - 1;
        const isEmpty = beat.status === "empty";
        return (
          <span
            key={i}
            title={beatTooltip(beat)}
            className={[
              "min-w-[2px] flex-1 rounded-[2px]",
              beatSegmentClass(beat.status),
              isEmpty ? "h-2/5 opacity-70" : "h-full",
              isLast && justBeat && !isEmpty ? "animate-beat-pulse" : "",
            ]
              .filter(Boolean)
              .join(" ")}
          />
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ServiceCard
// ---------------------------------------------------------------------------

export function ServiceCard({ service, viewMode, justUpdated = false, justBeat = false, onOpenDetail }: ServiceCardProps) {
  const meta = statusMeta(service);
  const badgeLabel = sourceBadgeLabel(service);
  const history = service.history ?? [];
  const showStale = service.stale && !service.maintenance;

  const openDetail = () => onOpenDetail(service.service_name);
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openDetail();
    }
  };

  // Consumed by the `animate-live-update-flash` keyframes (index.css) via
  // `var(--live-glow, ...)` — set per this card's current status color so
  // the one-shot flash ring matches whatever's actually being flashed.
  const glowStyle = { "--live-glow": meta.glowVar } as CSSProperties;

  const interactiveProps = {
    role: "button" as const,
    tabIndex: 0,
    onClick: openDetail,
    onKeyDown: handleKeyDown,
    "aria-label": `${service.service_name}, ${meta.label.toLowerCase()}. View details`,
  };

  if (viewMode === "list") {
    return (
      <div
        {...interactiveProps}
        style={glowStyle}
        className={`glass group flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors duration-[var(--duration-base)] ease-out hover:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
          justUpdated ? "animate-live-update-flash" : ""
        }`}
      >
        <StatusDot meta={meta} />

        <span className="w-32 shrink-0 truncate text-sm font-medium text-text-primary sm:w-44" title={service.service_name}>
          {service.service_name}
        </span>

        {badgeLabel && (
          <span className="hidden shrink-0 rounded-full border border-border bg-panel-bg px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary sm:inline-block">
            {badgeLabel}
          </span>
        )}

        <span className={`w-20 shrink-0 text-xs font-semibold uppercase tracking-wide ${meta.text}`}>{meta.label}</span>

        {showStale && (
          <span className="hidden shrink-0 rounded-full bg-unknown-bg px-1.5 py-0.5 text-[10px] font-medium text-unknown sm:inline-block">
            Stale
          </span>
        )}

        <span className="hidden min-w-0 flex-1 truncate text-xs text-text-secondary md:block" title={service.message || undefined}>
          {service.message || "—"}
        </span>

        <HeartbeatBar history={history} justBeat={justBeat} className="hidden w-36 shrink-0 lg:flex" />

        <span className="w-20 shrink-0 text-right text-[11px] text-text-muted">{formatRelativeTime(service.last_seen)}</span>

        <span className="shrink-0 text-text-muted transition-colors duration-[var(--duration-fast)] group-hover:text-accent">
          <IconChevronRight />
        </span>
      </div>
    );
  }

  return (
    <div
      {...interactiveProps}
      style={glowStyle}
      className={`glass group flex cursor-pointer flex-col gap-3 p-4 transition-colors duration-[var(--duration-base)] ease-out hover:border-border-focus focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
        justUpdated ? "animate-live-update-flash" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot meta={meta} />
          <span className="truncate text-sm font-semibold text-text-primary" title={service.service_name}>
            {service.service_name}
          </span>
        </div>
        {badgeLabel && (
          <span className="shrink-0 rounded-full border border-border bg-panel-bg px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-secondary">
            {badgeLabel}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <span className={`text-xs font-semibold uppercase tracking-wide ${meta.text}`}>{meta.label}</span>
        {showStale && (
          <span className="rounded-full bg-unknown-bg px-1.5 py-0.5 text-[10px] font-medium text-unknown">Stale</span>
        )}
      </div>

      <p className="line-clamp-2 min-h-[2.4em] text-xs text-text-secondary" title={service.message || undefined}>
        {service.message || "—"}
      </p>

      <HeartbeatBar history={history} justBeat={justBeat} />

      <div className="flex items-center justify-between pt-1 text-[11px] text-text-muted">
        <span>{formatRelativeTime(service.last_seen)}</span>
        <span className="inline-flex items-center gap-1 font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] group-hover:text-accent">
          Details
          <IconChevronRight />
        </span>
      </div>
    </div>
  );
}

export default ServiceCard;
