// Monitors settings tab — replaces the temporary build stub. Self-contained
// content for the Settings drawer's "Monitors" tab (see SettingsDrawer.tsx,
// which mounts this as `<MonitorsTab />` with no props): a list of every
// service with its active-monitor status (GET /api/monitors, see
// ActiveMonitor), and for a selected service, a form to add/edit that
// service's active check (PUT .../monitor, see SetServiceMonitorRequest) or
// remove it (DELETE .../monitor).
//
// List → detail navigation follows DiagnosticsDrawer's DiagnosticRunsTab
// precedent exactly (a "Back to services" replace, not a side-by-side
// master-detail split) — this drawer is only max-w-md/xl wide, too narrow
// for two panes to read comfortably side by side.
//
// GET /api/services/:name/monitor 404s when the service has no active
// monitor configured (see monitors.ts's doc comment on getServiceMonitor) —
// this is the normal "not configured" case, not an error, and is handled as
// such below (mirrors ServiceDetailDrawer's metadataStatus "not-found"
// handling for the same reason).
//
// No shared utils module exists in this codebase yet (see DiagnosticsDrawer's
// own header comment) — the small formatting/style helpers below are a
// drawer-local copy of the same pattern used there and in
// ServiceDetailDrawer.tsx, not an import from either.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "../../api/http.ts";
import { deleteServiceMonitor, getServiceMonitor, listMonitors, setServiceMonitor } from "../../api/monitors.ts";
import { listServices } from "../../api/services.ts";
import type { ActiveMonitor, MonitorType, ServiceSummary, SetServiceMonitorRequest } from "../../api/types.ts";

// ---------------------------------------------------------------------------
// Small local icons — same 20x20 stroke style as the drawer components.
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function IconChevronLeft({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M12.5 4.5L6.5 10l6 5.5" />
    </svg>
  );
}

function IconChevronRight({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M7.5 4.5l6 5.5-6 5.5" />
    </svg>
  );
}

function IconSearch({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <line x1="16.5" y1="16.5" x2="12.6" y2="12.6" />
    </svg>
  );
}

function IconRefresh({ className = "h-3.5 w-3.5", spinning = false }: IconProps & { spinning?: boolean }) {
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

function IconCheck({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
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

function formatRelative(iso: string | null | undefined): string {
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

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function isMonitorType(v: string): v is MonitorType {
  return v === "http" || v === "tcp" || v === "ping";
}

// ---------------------------------------------------------------------------
// Small reusable pieces
// ---------------------------------------------------------------------------

function SectionHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{children}</h3>
      {action}
    </div>
  );
}

function SkeletonRow() {
  return <div className="glass-subtle h-14 animate-shimmer" aria-hidden="true" />;
}

const inputClass =
  "w-full rounded-md border border-border bg-bg px-3 py-1.5 text-sm text-text-primary outline-none transition-colors duration-[var(--duration-fast)] ease-out placeholder:text-text-muted focus:border-border-focus disabled:opacity-50";

const selectClass = inputClass;

const primaryBtnClass =
  "inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-transform duration-[var(--duration-fast)] ease-out active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50";

const ghostBtnClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";

const dangerBtnClass =
  "inline-flex items-center gap-1.5 rounded-md bg-down px-3 py-1.5 text-xs font-medium text-white transition-transform duration-[var(--duration-fast)] ease-out active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50";

const dangerGhostBtnClass =
  "inline-flex items-center gap-1.5 rounded-md border border-down/30 px-3 py-1.5 text-xs font-medium text-down transition-colors duration-[var(--duration-fast)] ease-out hover:bg-down-bg disabled:cursor-not-allowed disabled:opacity-50";

// Per-type target hint — descriptive copy only (placeholder + helper text),
// not an assertion about the server's exact check semantics.
const MONITOR_TYPE_OPTIONS: { value: MonitorType; label: string; placeholder: string; hint: string }[] = [
  { value: "http", label: "HTTP(S)", placeholder: "https://example.com/health", hint: "Full URL to request on an interval." },
  { value: "tcp", label: "TCP", placeholder: "host:port", hint: "Host and port to open a TCP connection to." },
  { value: "ping", label: "Ping", placeholder: "host or IP address", hint: "Host or IP to send an ICMP echo request to." },
];

interface MonitorFormState {
  monitorType: MonitorType;
  target: string;
  /** Kept as free text while editing (so the field can be briefly empty
   * mid-edit) and parsed to a number only at validate/submit time. */
  intervalSeconds: string;
  enabled: boolean;
}

const DEFAULT_FORM: MonitorFormState = { monitorType: "http", target: "", intervalSeconds: "60", enabled: true };

function formFromMonitor(m: ActiveMonitor): MonitorFormState {
  return {
    monitorType: isMonitorType(m.monitor_type) ? m.monitor_type : "http",
    target: m.target,
    intervalSeconds: String(m.interval_seconds),
    enabled: m.enabled,
  };
}

// ---------------------------------------------------------------------------
// Detail view — add/edit/remove the selected service's active monitor.
// Always re-fetches via getServiceMonitor on mount/selection change (the
// list's ActiveMonitor rows are enough for the list badges, but the detail
// form loads its own authoritative copy, same as DiagnosticsDrawer's
// RunDetailView does for a run).
// ---------------------------------------------------------------------------

type DetailStatus = "loading" | "configured" | "not-configured" | "error";
type RemoveState = "idle" | "confirm" | "pending" | "error";

function ServiceMonitorDetail({
  serviceName,
  onBack,
  onSaved,
  onRemoved,
}: {
  serviceName: string;
  onBack: () => void;
  onSaved: (monitor: ActiveMonitor) => void;
  onRemoved: () => void;
}) {
  const typeId = useId();
  const targetId = useId();
  const intervalId = useId();

  const [status, setStatus] = useState<DetailStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [existingMonitor, setExistingMonitor] = useState<ActiveMonitor | null>(null);
  const [form, setForm] = useState<MonitorFormState>(DEFAULT_FORM);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [removeState, setRemoveState] = useState<RemoveState>("idle");
  const [removeError, setRemoveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setLoadError(null);
    getServiceMonitor(serviceName)
      .then((m) => {
        if (cancelled) return;
        setExistingMonitor(m);
        setForm(formFromMonitor(m));
        setStatus("configured");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setExistingMonitor(null);
          setForm(DEFAULT_FORM);
          setStatus("not-configured");
          return;
        }
        setStatus("error");
        setLoadError(errMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [serviceName]);

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  const activeTypeOption = MONITOR_TYPE_OPTIONS.find((o) => o.value === form.monitorType) ?? MONITOR_TYPE_OPTIONS[0];
  const parsedInterval = Number(form.intervalSeconds);
  const targetValid = form.target.trim() !== "";
  const intervalValid = form.intervalSeconds.trim() !== "" && Number.isInteger(parsedInterval) && parsedInterval >= 5;
  const canSave = targetValid && intervalValid && !saving && status !== "loading";

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body: SetServiceMonitorRequest = {
        monitor_type: form.monitorType,
        target: form.target.trim(),
        interval_seconds: parsedInterval,
        enabled: form.enabled,
      };
      const result = await setServiceMonitor(serviceName, body);
      setExistingMonitor(result);
      setForm(formFromMonitor(result));
      setStatus("configured");
      onSaved(result);
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      setSaveError(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmRemove() {
    setRemoveState("pending");
    setRemoveError(null);
    try {
      await deleteServiceMonitor(serviceName);
      setExistingMonitor(null);
      setForm(DEFAULT_FORM);
      setStatus("not-configured");
      setRemoveState("idle");
      onRemoved();
    } catch (err) {
      setRemoveState("error");
      setRemoveError(errMessage(err));
    }
  }

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className={ghostBtnClass}>
        <IconChevronLeft /> Back to services
      </button>

      <div>
        <h4 className="truncate text-sm font-semibold text-text-primary">{serviceName}</h4>
        <p className="mt-0.5 text-xs text-text-muted">
          {status === "loading" && "Loading monitor…"}
          {status === "configured" && "Active monitor configured"}
          {status === "not-configured" && "No active monitor configured"}
          {status === "error" && "Failed to load monitor"}
        </p>
      </div>

      {status === "loading" && <SkeletonRow />}
      {status === "error" && <p className="text-sm text-down">{loadError}</p>}

      {(status === "configured" || status === "not-configured") && (
        <>
          {status === "configured" && existingMonitor && (
            <div className="glass-subtle grid grid-cols-2 gap-x-3 gap-y-2 px-3 py-3 text-xs">
              <div>
                <p className="text-text-muted">Last checked</p>
                <p className="text-text-primary">{formatRelative(existingMonitor.last_checked_at)}</p>
              </div>
              {existingMonitor.cert_expiry_at && (
                <div>
                  <p className="text-text-muted">Certificate</p>
                  <p className={existingMonitor.cert_warning ? "text-down" : "text-text-primary"} title={formatDateTime(existingMonitor.cert_expiry_at)}>
                    {existingMonitor.cert_days_remaining !== null
                      ? `${existingMonitor.cert_days_remaining}d remaining`
                      : formatDateTime(existingMonitor.cert_expiry_at)}
                  </p>
                </div>
              )}
            </div>
          )}

          <div className="space-y-3">
            <div>
              <label htmlFor={typeId} className="mb-1 block text-[11px] uppercase tracking-wide text-text-muted">
                Check type
              </label>
              <select
                id={typeId}
                value={form.monitorType}
                onChange={(e) => setForm((f) => ({ ...f, monitorType: e.target.value as MonitorType }))}
                disabled={saving}
                className={selectClass}
              >
                {MONITOR_TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor={targetId} className="mb-1 block text-[11px] uppercase tracking-wide text-text-muted">
                Target
              </label>
              <input
                id={targetId}
                type="text"
                value={form.target}
                onChange={(e) => setForm((f) => ({ ...f, target: e.target.value }))}
                placeholder={activeTypeOption.placeholder}
                disabled={saving}
                className={inputClass}
              />
              <p className="mt-1 text-[11px] text-text-muted">{activeTypeOption.hint}</p>
            </div>

            <div>
              <label htmlFor={intervalId} className="mb-1 block text-[11px] uppercase tracking-wide text-text-muted">
                Check interval (seconds)
              </label>
              <input
                id={intervalId}
                type="number"
                min={5}
                step={5}
                value={form.intervalSeconds}
                onChange={(e) => setForm((f) => ({ ...f, intervalSeconds: e.target.value }))}
                disabled={saving}
                className={inputClass}
              />
              {!intervalValid && <p className="mt-1 text-[11px] text-down">Enter a whole number of at least 5 seconds.</p>}
            </div>

            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-text-primary">Enabled</span>
              <button
                type="button"
                role="switch"
                aria-checked={form.enabled}
                aria-label="Monitor enabled"
                onClick={() => setForm((f) => ({ ...f, enabled: !f.enabled }))}
                disabled={saving}
                className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-[var(--duration-fast)] ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
                  form.enabled ? "border-accent/40 bg-accent" : "border-border bg-panel-bg"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform duration-[var(--duration-fast)] ease-out ${
                    form.enabled ? "translate-x-[22px]" : "translate-x-0.5"
                  }`}
                />
              </button>
            </div>
          </div>

          {saveError && <p className="text-xs text-down">{saveError}</p>}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div>
              {status === "configured" && removeState === "idle" && (
                <button type="button" onClick={() => setRemoveState("confirm")} className={dangerGhostBtnClass}>
                  Remove monitor
                </button>
              )}
              {removeState === "confirm" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary">Remove this monitor?</span>
                  <button type="button" onClick={() => void handleConfirmRemove()} className={dangerBtnClass}>
                    Confirm
                  </button>
                  <button type="button" onClick={() => setRemoveState("idle")} className={ghostBtnClass}>
                    Cancel
                  </button>
                </div>
              )}
              {removeState === "pending" && <span className="text-xs text-text-muted">Removing…</span>}
              {removeState === "error" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-down">{removeError}</span>
                  <button type="button" onClick={() => setRemoveState("idle")} className="text-xs text-text-secondary underline">
                    Try again
                  </button>
                </div>
              )}
            </div>

            <button type="button" onClick={() => void handleSave()} disabled={!canSave} className={`${primaryBtnClass} ml-auto`}>
              {saving ? (
                "Saving…"
              ) : saved ? (
                <>
                  <IconCheck /> Saved
                </>
              ) : status === "configured" ? (
                "Save changes"
              ) : (
                "Add monitor"
              )}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// List view — every service with its current monitor status.
// ---------------------------------------------------------------------------

function ServiceRow({
  service,
  monitor,
  onSelect,
}: {
  service: ServiceSummary;
  monitor: ActiveMonitor | undefined;
  onSelect: (name: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(service.service_name)}
      className="glass-subtle flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text-primary">{service.service_name}</p>
        <p className="mt-0.5 truncate text-xs text-text-muted">
          {monitor ? (
            <>
              <span className={monitor.enabled ? "text-up" : "text-degraded"}>{monitor.enabled ? "Active" : "Paused"}</span>
              {` · ${monitor.monitor_type.toUpperCase()} · every ${monitor.interval_seconds}s`}
              {monitor.cert_warning && <span className="text-down"> · cert expiring</span>}
            </>
          ) : (
            "Not configured"
          )}
        </p>
      </div>
      <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MonitorsTab() {
  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [monitors, setMonitors] = useState<Map<string, ActiveMonitor>>(new Map());
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedService, setSelectedService] = useState<string | null>(null);

  const loadList = useCallback(() => {
    setListLoading(true);
    setListError(null);
    Promise.all([listServices(), listMonitors()])
      .then(([svc, mons]) => {
        setServices(svc);
        setMonitors(new Map(mons.map((m) => [m.service_name, m])));
      })
      .catch((err: unknown) => setListError(errMessage(err)))
      .finally(() => setListLoading(false));
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const filteredServices = useMemo(() => {
    const sorted = [...services].sort((a, b) => a.service_name.localeCompare(b.service_name));
    const q = search.trim().toLowerCase();
    if (q === "") return sorted;
    return sorted.filter((s) => s.service_name.toLowerCase().includes(q));
  }, [services, search]);

  // Local map updates on save/remove avoid a full list re-fetch, same as
  // ServiceDetailDrawer updating `summary` in place from setServiceGroup's
  // response rather than reloading the whole service list.
  function handleSaved(monitor: ActiveMonitor) {
    setMonitors((prev) => {
      const next = new Map(prev);
      next.set(monitor.service_name, monitor);
      return next;
    });
  }

  function handleRemoved() {
    if (!selectedService) return;
    setMonitors((prev) => {
      const next = new Map(prev);
      next.delete(selectedService);
      return next;
    });
  }

  if (selectedService) {
    return (
      <ServiceMonitorDetail
        serviceName={selectedService}
        onBack={() => setSelectedService(null)}
        onSaved={handleSaved}
        onRemoved={handleRemoved}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search services…"
          aria-label="Search services"
          className={`${inputClass} pl-9`}
        />
      </div>

      <section>
        <SectionHeading
          action={
            <button type="button" onClick={loadList} disabled={listLoading} aria-label="Refresh monitors" className={ghostBtnClass}>
              <IconRefresh spinning={listLoading} />
            </button>
          }
        >
          Services
        </SectionHeading>
        <div className="space-y-2">
          {listLoading && services.length === 0 && (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          )}
          {listError && <p className="text-sm text-down">{listError}</p>}
          {!listLoading && !listError && filteredServices.length === 0 && (
            <p className="text-sm text-text-muted">
              {services.length === 0 ? "No services yet." : `No services match "${search}"`}
            </p>
          )}
          {filteredServices.map((s) => (
            <ServiceRow key={s.service_name} service={s} monitor={monitors.get(s.service_name)} onSelect={setSelectedService} />
          ))}
        </div>
      </section>
    </div>
  );
}

export default MonitorsTab;
