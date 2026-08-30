// Root of the app: wires useAuth()'s five-state derivation to what's on
// screen, and (for the three "dashboard" states) provides the persistent
// chrome — sticky header, live clock, view/group controls, connection
// status — around the real dashboard content: the metrics row + outage
// banner, the filter toolbar, the grouped/flat grid-or-list of service
// cards, the detail drawer, and the Cmd/Ctrl+K command palette. All five
// live in src/components/ — this file only reconciles their prop shapes
// against each other and against useLanternRealtime's output.
import { useEffect, useMemo, useState } from "react";
import Aurora from "./components/Aurora.tsx";
import ShinyText from "./components/ShinyText.tsx";
import { LoginForm } from "./components/LoginForm.tsx";
import { ServiceCard } from "./components/ServiceCard.tsx";
import {
  ServiceToolbar,
  applyServiceFilters,
  DEFAULT_SERVICE_FILTER_STATE,
  UNGROUPED_GROUP_VALUE,
} from "./components/ServiceToolbar.tsx";
import type { ServiceFilterState } from "./components/ServiceToolbar.tsx";
import { MetricsRow, OutageBanner } from "./components/MetricsBanner.tsx";
import { ServiceDetailDrawer } from "./components/ServiceDetailDrawer.tsx";
import { CommandPalette } from "./components/CommandPalette.tsx";
import { DiagnosticsDrawer } from "./components/DiagnosticsDrawer.tsx";
import { SettingsDrawer } from "./components/SettingsDrawer.tsx";
import { AuthProvider, useAuth } from "./hooks/useAuth.tsx";
import { THEME_CHANGE_EVENT, auroraStopsForAccent, getStoredAccent } from "./theme.ts";
import { useLanternRealtime } from "./hooks/useLanternRealtime.ts";
import type { LanternConnectionStatus } from "./hooks/useLanternRealtime.ts";
import type { ServiceSummary } from "./api/types.ts";

// ---------------------------------------------------------------------------
// Icons — small inline stroke SVGs (no icon package added just for a
// handful of header glyphs). 20x20 viewBox, currentColor stroke so they pick
// up whatever text color class the caller sets.
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function IconGrid({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="3" width="6" height="6" rx="1.2" />
      <rect x="11" y="3" width="6" height="6" rx="1.2" />
      <rect x="3" y="11" width="6" height="6" rx="1.2" />
      <rect x="11" y="11" width="6" height="6" rx="1.2" />
    </svg>
  );
}

function IconList({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <line x1="3" y1="5" x2="17" y2="5" />
      <line x1="3" y1="10" x2="17" y2="10" />
      <line x1="3" y1="15" x2="17" y2="15" />
    </svg>
  );
}

function IconGroup({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="7" cy="7" r="2.6" />
      <circle cx="14.2" cy="8.6" r="2.1" />
      <path d="M2.3 16.2c.6-2.7 2.4-4.2 4.7-4.2s4.1 1.5 4.7 4.2" />
      <path d="M12 12.3c1.7.2 3 1.5 3.6 3.9" />
    </svg>
  );
}

function IconActivity({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <polyline points="2.5,11 6,11 8,4.5 12,15.5 14,9 17.5,9" />
    </svg>
  );
}

function IconSettings({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="10" cy="10" r="2.6" />
      <path d="M10 2.5v2.1M10 15.4v2.1M17.5 10h-2.1M4.6 10H2.5M15.1 4.9l-1.5 1.5M6.4 13.6l-1.5 1.5M15.1 15.1l-1.5-1.5M6.4 6.4 4.9 4.9" />
    </svg>
  );
}

function IconRefresh({ className = "h-4 w-4", spinning = false }: IconProps & { spinning?: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`${className}${spinning ? " animate-spin" : ""}`}
      aria-hidden="true"
    >
      <path d="M16.5 10a6.5 6.5 0 1 1-2.1-4.8" />
      <path d="M16.5 3.5v3.6h-3.6" />
    </svg>
  );
}

function IconLogout({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M8 17H4.5A1.5 1.5 0 0 1 3 15.5v-11A1.5 1.5 0 0 1 4.5 3H8" />
      <path d="M13 14l4-4-4-4" />
      <path d="M17 10H7.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Animated background — mounted exactly once, as a sibling of the
// status-branching content below, so switching between loading / login /
// dashboard never remounts (and therefore never restarts/flickers) it.
// ---------------------------------------------------------------------------

function AppBackground() {
  // Seeded from whatever theme.ts / index.html's pre-React bootstrap script
  // already applied, then kept live via THEME_CHANGE_EVENT — applyAccent
  // (theme.ts) fires it on every Settings change, since this component is
  // mounted once as a stable sibling (never remounted when the Settings
  // drawer opens) and so can't just re-read localStorage on render.
  // colorStops is derived from the live accent (auroraStopsForAccent) so
  // the animated background always reads as "this accent's aurora" instead
  // of a fixed green/blue/violet regardless of what's picked. Midnight is
  // the app's only look, so there's no lightMode to track here anymore.
  const [colorStops, setColorStops] = useState<[string, string, string]>(() => auroraStopsForAccent(getStoredAccent()));

  useEffect(() => {
    const sync = () => setColorStops(auroraStopsForAccent(getStoredAccent()));
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden" aria-hidden="true">
      <Aurora colorStops={colorStops} amplitude={0.85} blend={0.65} speed={0.5} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// "loading" — a minimal centered glass panel while the initial
// GET /api/auth/session round-trip is in flight.
// ---------------------------------------------------------------------------

function LoadingScreen() {
  return (
    <div className="relative z-10 flex min-h-screen items-center justify-center px-4 font-sans">
      <div className="glass-strong flex items-center gap-3 px-6 py-4">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" aria-hidden="true" />
        <span className="text-sm text-text-secondary">Loading Lantern…</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard shell — "open" | "authenticated" | "public".
// ---------------------------------------------------------------------------

function useClock(): string {
  const [label, setLabel] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => setLabel(formatClock(new Date())), 1000);
    return () => window.clearInterval(id);
  }, []);
  return label;
}

function formatClock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function segButtonClass(active: boolean): string {
  const base = "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors duration-[var(--duration-fast)] ease-out";
  return active
    ? `${base} bg-accent text-white shadow-[0_0_16px_-4px_var(--color-accent-glow)]`
    : `${base} text-text-secondary hover:bg-panel-hover hover:text-text-primary`;
}

function iconButtonClass(): string {
  return "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";
}

function ConnectionBadge({ status }: { status: Exclude<LanternConnectionStatus, "connected"> }) {
  const disconnected = status === "disconnected";
  return (
    <span
      role="status"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
        disconnected ? "border-down/30 bg-down-bg text-down" : "border-degraded/30 bg-degraded-bg text-degraded"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${disconnected ? "bg-down" : "bg-degraded animate-pulse"}`} aria-hidden="true" />
      {disconnected ? "Disconnected" : "Reconnecting…"}
    </span>
  );
}

type DashboardStatus = "open" | "authenticated" | "public";

// One named group's section (or the single flat list when `grouped` is
// off): renders `services` as either a responsive card grid or a stacked
// list of rows, per ServiceCard's own `viewMode` contract. `justUpdated` /
// `justBeat` are the raw Sets straight from useLanternRealtime — the
// per-card `.has(service_name)` lookup ServiceCard expects happens once per
// card here, not in the caller.
function ServiceGrid({
  services,
  viewMode,
  justUpdated,
  justBeat,
  onOpenDetail,
}: {
  services: ServiceSummary[];
  viewMode: "grid" | "list";
  justUpdated: Set<string>;
  justBeat: Set<string>;
  onOpenDetail: (serviceName: string) => void;
}) {
  if (viewMode === "list") {
    return (
      <div className="flex flex-col gap-2">
        {services.map((service) => (
          <ServiceCard
            key={service.service_name}
            service={service}
            viewMode="list"
            justUpdated={justUpdated.has(service.service_name)}
            justBeat={justBeat.has(service.service_name)}
            onOpenDetail={onOpenDetail}
          />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {services.map((service) => (
        <ServiceCard
          key={service.service_name}
          service={service}
          viewMode="grid"
          justUpdated={justUpdated.has(service.service_name)}
          justBeat={justBeat.has(service.service_name)}
          onOpenDetail={onOpenDetail}
        />
      ))}
    </div>
  );
}

interface GroupSection {
  key: string;
  label: string;
  services: ServiceSummary[];
}

function DashboardShell({ status }: { status: DashboardStatus }) {
  const { username, logout } = useAuth();
  // `public` picks the /api/public/* + /api/public/ws endpoint pair inside
  // the hook — this is the one piece of real integration logic this phase
  // owns beyond just calling the hook.
  const { services, connectionStatus, refresh, justUpdated, justBeat } = useLanternRealtime({
    public: status === "public",
  });

  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [grouped, setGrouped] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filters, setFilters] = useState<ServiceFilterState>(DEFAULT_SERVICE_FILTER_STATE);
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const clock = useClock();

  const filteredServices = useMemo(() => applyServiceFilters(services, filters), [services, filters]);

  // Sections the grid renders under when `grouped` is on — Ungrouped first
  // (mirroring ServiceToolbar's own group-dropdown ordering), then named
  // groups alphabetically. Built from `filteredServices`, not the raw
  // `services`, so a search/status/source filter narrows every section
  // consistently instead of only the flat view.
  const groupedSections = useMemo<GroupSection[] | null>(() => {
    if (!grouped) return null;
    const buckets = new Map<string, ServiceSummary[]>();
    for (const s of filteredServices) {
      const bucket = buckets.get(s.group_name);
      if (bucket) bucket.push(s);
      else buckets.set(s.group_name, [s]);
    }
    const sections: GroupSection[] = [];
    const ungrouped = buckets.get("");
    if (ungrouped) sections.push({ key: UNGROUPED_GROUP_VALUE, label: "Ungrouped", services: ungrouped });
    const namedGroups = Array.from(buckets.keys())
      .filter((name) => name !== "")
      .sort((a, b) => a.localeCompare(b));
    for (const name of namedGroups) {
      sections.push({ key: name, label: name, services: buckets.get(name)! });
    }
    return sections;
  }, [grouped, filteredServices]);

  // Cmd/Ctrl+K opens the command palette. CommandPalette is fully
  // controlled and only handles Escape/Up/Down/Enter internally, scoped to
  // while it's already `open` (see its own header comment) — it has no
  // `onOpen` callback and never listens for the opening shortcut itself, so
  // owning that global listener is this shell's job.
  useEffect(() => {
    function handleOpenShortcut(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    }
    document.addEventListener("keydown", handleOpenShortcut);
    return () => document.removeEventListener("keydown", handleOpenShortcut);
  }, []);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refresh();
    } catch (err) {
      console.error("Manual refresh failed:", err);
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSignOut() {
    try {
      await logout();
    } catch (err) {
      // Sign-out failing (network blip, already-expired session) shouldn't
      // strand the user on a dead button with no feedback path yet — a
      // later phase can surface this via a toast. Logging keeps it visible
      // during development in the meantime.
      console.error("Sign out failed:", err);
    }
  }

  return (
    <div className="relative z-10 flex min-h-screen flex-col font-sans text-text-primary">
      <header className="glass-subtle sticky top-3 z-30 mx-3 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 sm:mx-4 sm:top-4">
        <div className="flex items-center gap-2.5">
          <span className="h-2 w-2 rounded-full bg-accent shadow-[0_0_12px_var(--color-accent-glow)]" aria-hidden="true" />
          <h1 className="m-0 leading-none">
            <ShinyText
              text="Lantern"
              className="text-lg font-semibold"
              color="var(--color-text-secondary)"
              shineColor="var(--color-text-primary)"
              speed={3}
              spread={100}
            />
          </h1>
          {status === "public" && (
            <span className="rounded-full border border-border bg-panel-bg px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-text-muted">
              Public view
            </span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Grid/List view-mode toggle — drives ServiceGrid's layout below. */}
          <div className="flex items-center gap-0.5 rounded-md border border-border bg-panel-bg/60 p-0.5" role="group" aria-label="View mode">
            <button type="button" onClick={() => setViewMode("grid")} aria-pressed={viewMode === "grid"} className={segButtonClass(viewMode === "grid")}>
              <IconGrid />
              Grid
            </button>
            <button type="button" onClick={() => setViewMode("list")} aria-pressed={viewMode === "list"} className={segButtonClass(viewMode === "list")}>
              <IconList />
              List
            </button>
          </div>

          {/* Group toggle — sections the grid below by group_name when on. */}
          <button type="button" onClick={() => setGrouped((g) => !g)} aria-pressed={grouped} className={segButtonClass(grouped)}>
            <IconGroup />
            Group
          </button>

          <span className="select-none font-mono text-sm tabular-nums text-text-secondary" aria-label="Current time">
            {clock}
          </span>

          {connectionStatus !== "connected" && <ConnectionBadge status={connectionStatus} />}

          {status === "authenticated" && username && (
            <span className="hidden text-xs text-text-muted lg:inline">Signed in as {username}</span>
          )}

          <div className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />

          <button type="button" onClick={() => setDiagnosticsOpen(true)} title="Diagnostics" aria-label="Diagnostics" className={iconButtonClass()}>
            <IconActivity />
          </button>
          <button type="button" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings" className={iconButtonClass()}>
            <IconSettings />
          </button>
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            title="Refresh"
            aria-label="Refresh services"
            className={iconButtonClass()}
          >
            <IconRefresh spinning={refreshing} />
          </button>

          <button
            type="button"
            onClick={() => void handleSignOut()}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover hover:text-text-primary"
          >
            <IconLogout />
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-3 mb-6 mt-8 flex flex-1 flex-col gap-4 sm:mx-4 sm:mt-9">
        <MetricsRow services={services} />
        <OutageBanner services={services} />

        <ServiceToolbar services={services} filters={filters} onFiltersChange={setFilters} />

        {filteredServices.length === 0 ? (
          <div className="glass p-10 text-center text-sm text-text-secondary">
            {services.length === 0 ? "No services yet." : "No services match the current filters."}
          </div>
        ) : grouped && groupedSections ? (
          <div className="flex flex-col gap-6">
            {groupedSections.map((section) => (
              <div key={section.key}>
                <h2 className="mb-2.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-muted">
                  {section.label}
                  <span className="rounded-full bg-panel-hover px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-text-muted">
                    {section.services.length}
                  </span>
                </h2>
                <ServiceGrid
                  services={section.services}
                  viewMode={viewMode}
                  justUpdated={justUpdated}
                  justBeat={justBeat}
                  onOpenDetail={setSelectedService}
                />
              </div>
            ))}
          </div>
        ) : (
          <ServiceGrid
            services={filteredServices}
            viewMode={viewMode}
            justUpdated={justUpdated}
            justBeat={justBeat}
            onOpenDetail={setSelectedService}
          />
        )}
      </main>

      <ServiceDetailDrawer serviceName={selectedService} onClose={() => setSelectedService(null)} />
      <CommandPalette
        services={services}
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectService={setSelectedService}
      />
      <DiagnosticsDrawer open={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function AppShell() {
  const { status } = useAuth();

  if (status === "loading") return <LoadingScreen />;
  if (status === "gate-login") return <LoginForm />;
  // TypeScript narrows `status` to exactly "open" | "authenticated" |
  // "public" here (AuthStatus has no other members) — no cast needed.
  return <DashboardShell status={status} />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppBackground />
      <AppShell />
    </AuthProvider>
  );
}
