// Toolbar for the service grid/list: search box, Source filter pills, Status
// filter pills, and a group-filter dropdown. Purely a controlled component —
// it owns no filtering state itself, just renders `filters` and reports
// changes via `onFiltersChange`. The integration phase owns the actual
// `useState<ServiceFilterState>` and threads the filtered list (via
// `applyServiceFilters`, exported below) down to the grid.
//
// Counts on the Source pills and the group dropdown's options are always
// computed from the full `services` prop (not from an already-filtered
// subset) — narrowing one filter shouldn't make the others' counts/options
// shift under the user, and it keeps this component ignorant of the other
// filters' combined effect.
import { useMemo, useState } from "react";
import type { ServiceSummary } from "../api/types.ts";

// ---------------------------------------------------------------------------
// Types shared with the integration phase.
// ---------------------------------------------------------------------------

export type SourceFilter = "all" | "docker" | "host" | "monitor";

export type StatusFilter = "all" | "issues" | "down" | "degraded" | "maintenance";

// Sentinel for "services with group_name === ''" in the group dropdown,
// distinct from `group: ""` which means "All Groups" (no group filtering at
// all). Exported so the integration phase can recognize/construct it too
// (e.g. if it wants to preselect the Ungrouped bucket).
export const UNGROUPED_GROUP_VALUE = "__ungrouped__";

export interface ServiceFilterState {
  /** Case-insensitive substring match against service_name. */
  search: string;
  source: SourceFilter;
  status: StatusFilter;
  /** "" = All Groups, UNGROUPED_GROUP_VALUE = group_name === "", else an
   * exact group_name match. */
  group: string;
}

export const DEFAULT_SERVICE_FILTER_STATE: ServiceFilterState = {
  search: "",
  source: "all",
  status: "all",
  group: "",
};

// ---------------------------------------------------------------------------
// Pure filtering — export so the integration phase (and the grid/list it
// feeds) can reuse this directly instead of reimplementing the same rules.
// ---------------------------------------------------------------------------

export function applyServiceFilters<T extends ServiceSummary>(
  services: T[],
  filters: ServiceFilterState
): T[] {
  const search = filters.search.trim().toLowerCase();

  return services.filter((s) => {
    if (search !== "" && !s.service_name.toLowerCase().includes(search)) return false;

    if (filters.source !== "all" && s.source !== filters.source) return false;

    switch (filters.status) {
      case "down":
        if (s.status !== "down") return false;
        break;
      case "degraded":
        if (s.status !== "degraded") return false;
        break;
      case "maintenance":
        if (!s.maintenance) return false;
        break;
      // "Issues Only" per the spec: status is down, degraded, or stale.
      case "issues":
        if (s.status !== "down" && s.status !== "degraded" && !s.stale) return false;
        break;
      case "all":
      default:
        break;
    }

    if (filters.group !== "") {
      const wantUngrouped = filters.group === UNGROUPED_GROUP_VALUE;
      if (wantUngrouped ? s.group_name !== "" : s.group_name !== filters.group) return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Icons — small inline stroke SVGs, matching App.tsx's existing header icons
// (20x20 viewBox, currentColor stroke, strokeWidth 1.6) rather than pulling
// in an icon package.
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function IconSearch({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <line x1="16.5" y1="16.5" x2="12.6" y2="12.6" />
    </svg>
  );
}

function IconX({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <line x1="5" y1="5" x2="15" y2="15" />
      <line x1="15" y1="5" x2="5" y2="15" />
    </svg>
  );
}

function IconChevronDown({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="5,7.5 10,12.5 15,7.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Shared pill styling (mirrors App.tsx's segButtonClass for the header's
// Grid/List/Group toggles, so the toolbar reads as the same design language).
// ---------------------------------------------------------------------------

function pillClass(active: boolean): string {
  const base =
    "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition-colors duration-[var(--duration-fast)] ease-out";
  return active
    ? `${base} border-transparent bg-accent text-white shadow-[0_0_16px_-4px_var(--color-accent-glow)]`
    : `${base} border-border bg-panel-bg/60 text-text-secondary hover:bg-panel-hover hover:text-text-primary`;
}

function countBadgeClass(active: boolean): string {
  return `rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
    active ? "bg-white/20 text-white" : "bg-panel-hover text-text-muted"
  }`;
}

function useIsMacPlatform(): boolean {
  const [isMac] = useState(() => {
    if (typeof navigator === "undefined") return true;
    const platform = navigator.platform || navigator.userAgent || "";
    return /Mac|iPhone|iPad|iPod/i.test(platform);
  });
  return isMac;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const SOURCE_PILLS: Array<{ value: SourceFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "docker", label: "Docker" },
  { value: "host", label: "Host" },
  { value: "monitor", label: "Monitored" },
];

const STATUS_PILLS: Array<{ value: StatusFilter; label: string; dotClassName?: string }> = [
  { value: "all", label: "All" },
  { value: "issues", label: "Issues Only" },
  { value: "down", label: "Down", dotClassName: "bg-down" },
  { value: "degraded", label: "Degraded", dotClassName: "bg-degraded" },
  { value: "maintenance", label: "Maintenance", dotClassName: "bg-maint" },
];

export interface ServiceToolbarProps {
  services: ServiceSummary[];
  filters: ServiceFilterState;
  onFiltersChange: (next: ServiceFilterState) => void;
  /** Extra classes on the outer panel (e.g. spacing) — this component picks
   * no margin of its own so the integration phase controls placement. */
  className?: string;
}

export function ServiceToolbar({ services, filters, onFiltersChange, className = "" }: ServiceToolbarProps) {
  const isMac = useIsMacPlatform();

  const sourceCounts = useMemo(() => {
    let docker = 0;
    let host = 0;
    let monitor = 0;
    for (const s of services) {
      if (s.source === "docker") docker++;
      else if (s.source === "host") host++;
      else if (s.source === "monitor") monitor++;
    }
    return { all: services.length, docker, host, monitor };
  }, [services]);

  const groupOptions = useMemo(() => {
    const names = new Set<string>();
    let hasUngrouped = false;
    for (const s of services) {
      if (s.group_name === "") hasUngrouped = true;
      else names.add(s.group_name);
    }
    return { names: Array.from(names).sort((a, b) => a.localeCompare(b)), hasUngrouped };
  }, [services]);

  function patch(update: Partial<ServiceFilterState>) {
    onFiltersChange({ ...filters, ...update });
  }

  return (
    <section className={`glass p-4 sm:p-5 ${className}`} aria-label="Service filters">
      <div className="flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative min-w-[220px] flex-1 max-w-md">
          <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            type="search"
            value={filters.search}
            onChange={(e) => patch({ search: e.target.value })}
            placeholder="Search services…"
            aria-label="Search services"
            className="w-full rounded-md border border-border bg-bg py-2 pl-9 pr-16 text-base text-text-primary outline-none transition-colors duration-[var(--duration-fast)] ease-out placeholder:text-text-muted focus:border-border-focus"
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2">
            {filters.search !== "" ? (
              <button
                type="button"
                onClick={() => patch({ search: "" })}
                aria-label="Clear search"
                className="flex h-5 w-5 items-center justify-center rounded text-text-muted transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover hover:text-text-primary"
              >
                <IconX />
              </button>
            ) : (
              <kbd className="pointer-events-none hidden select-none items-center rounded border border-border bg-panel-bg px-1.5 py-0.5 font-mono text-[10px] text-text-muted sm:inline-flex">
                {isMac ? "⌘K" : "Ctrl K"}
              </kbd>
            )}
          </div>
        </div>

        {/* Group filter */}
        <div className="relative shrink-0">
          <select
            value={filters.group}
            onChange={(e) => patch({ group: e.target.value })}
            aria-label="Filter by group"
            className="appearance-none rounded-md border border-border bg-bg py-2 pl-3 pr-8 text-base text-text-primary outline-none transition-colors duration-[var(--duration-fast)] ease-out focus:border-border-focus"
          >
            <option value="">All Groups</option>
            {groupOptions.hasUngrouped && <option value={UNGROUPED_GROUP_VALUE}>Ungrouped</option>}
            {groupOptions.names.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <IconChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        {/* Source pills */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by source">
          {SOURCE_PILLS.map(({ value, label }) => {
            const active = filters.source === value;
            const count = value === "all" ? sourceCounts.all : sourceCounts[value];
            return (
              <button
                key={value}
                type="button"
                onClick={() => patch({ source: value })}
                aria-pressed={active}
                className={pillClass(active)}
              >
                {label}
                <span className={countBadgeClass(active)}>{count}</span>
              </button>
            );
          })}
        </div>

        {/* Status pills */}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by status">
          {STATUS_PILLS.map(({ value, label, dotClassName }) => {
            const active = filters.status === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => patch({ status: value })}
                aria-pressed={active}
                className={pillClass(active)}
              >
                {dotClassName && <span className={`h-1.5 w-1.5 rounded-full ${dotClassName}`} aria-hidden="true" />}
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
