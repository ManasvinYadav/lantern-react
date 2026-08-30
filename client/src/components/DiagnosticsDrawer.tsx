// Diagnostics drawer — a glass-strong side panel opened from the header's
// Diagnostics button (see App.tsx's DashboardShell), with two tabs:
//
//   "Diagnostic Runs" — log a new diagnostic run against a service
//   (POST /api/diagnostics: service_name + title + content, see
//   PostDiagnosticRequest), browse past runs (GET /api/diagnostics, see
//   DiagnosticRunSummary — id/service_name/title/timestamp/created_at, no
//   status/result field: a "run" here is an authored note, not an automated
//   health check), and drill into one run's full body (GET
//   /api/diagnostics/:id, see DiagnosticRunDetail, which is just the summary
//   shape plus `content`).
//
//   "Activity Log" — a chronological feed from GET /api/activity (see
//   ActivityEvent), a discriminated union of "status_change" and
//   "webhook_delivery" rows. Rendered directly from that shape's real
//   fields — there is no latency_ms on ActivityEvent (unlike StatusEvent
//   elsewhere), so a line never claims a duration the API didn't send.
//
// Controlled component, same entrance/Escape/scroll-lock/glass-strong
// precedent as ServiceDetailDrawer.tsx, but keyed on a plain `open` boolean
// instead of a service identity — there's nothing here to reset per-service.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { ApiError } from "../api/http.ts";
import { getActivity } from "../api/activity.ts";
import { getDiagnostic, listDiagnostics, postDiagnostic } from "../api/diagnostics.ts";
import { listServices } from "../api/services.ts";
import type {
  ActivityEvent,
  DiagnosticRunDetail,
  DiagnosticRunSummary,
  ServiceSummary,
} from "../api/types.ts";

export interface DiagnosticsDrawerProps {
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Small local icons — same 20x20 stroke style as ServiceDetailDrawer's set.
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function IconClose({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

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

// ---------------------------------------------------------------------------
// Formatting helpers — small drawer-local copies, matching the pattern
// already established by ServiceDetailDrawer.tsx (no shared utils module in
// this codebase yet; each drawer carries its own).
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

const textareaClass = `${inputClass} min-h-24 resize-y`;

const selectClass = inputClass;

const primaryBtnClass =
  "inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-transform duration-[var(--duration-fast)] ease-out active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50";

const ghostBtnClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type DrawerTab = "runs" | "activity";

function TabBar({ value, onChange }: { value: DrawerTab; onChange: (t: DrawerTab) => void }) {
  const tabs: { value: DrawerTab; label: string }[] = [
    { value: "runs", label: "Diagnostic Runs" },
    { value: "activity", label: "Activity Log" },
  ];
  return (
    <div className="flex items-center gap-0.5 rounded-md border border-border bg-panel-bg/60 p-0.5" role="tablist" aria-label="Diagnostics view">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={`rounded px-3 py-1.5 text-xs font-medium transition-colors duration-[var(--duration-fast)] ease-out ${
            value === t.value ? "bg-accent text-white" : "text-text-secondary hover:bg-panel-hover hover:text-text-primary"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diagnostic Runs tab
// ---------------------------------------------------------------------------

function NewRunForm({
  services,
  onCreated,
}: {
  services: ServiceSummary[];
  onCreated: () => void;
}) {
  const serviceListId = useId();
  const titleInputId = useId();
  const contentInputId = useId();

  const [serviceName, setServiceName] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const canSubmit = serviceName.trim() !== "" && title.trim() !== "" && content.trim() !== "" && !submitting;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await postDiagnostic({ service_name: serviceName.trim(), title: title.trim(), content: content.trim() });
      setTitle("");
      setContent("");
      onCreated();
    } catch (err) {
      setSubmitError(errMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="glass-subtle flex flex-col gap-2.5 p-3">
      <div>
        <label htmlFor={`${serviceListId}-input`} className="mb-1 block text-[11px] uppercase tracking-wide text-text-muted">
          Service
        </label>
        <input
          id={`${serviceListId}-input`}
          type="text"
          list={serviceListId}
          value={serviceName}
          onChange={(e) => setServiceName(e.target.value)}
          placeholder="Service name"
          disabled={submitting}
          className={inputClass}
        />
        <datalist id={serviceListId}>
          {services.map((s) => (
            <option key={s.service_name} value={s.service_name} />
          ))}
        </datalist>
      </div>

      <div>
        <label htmlFor={titleInputId} className="mb-1 block text-[11px] uppercase tracking-wide text-text-muted">
          Title
        </label>
        <input
          id={titleInputId}
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Investigated elevated latency"
          disabled={submitting}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor={contentInputId} className="mb-1 block text-[11px] uppercase tracking-wide text-text-muted">
          Notes
        </label>
        <textarea
          id={contentInputId}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="What did you find?"
          disabled={submitting}
          className={textareaClass}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        {submitError ? <p className="text-xs text-down">{submitError}</p> : <span />}
        <button type="submit" disabled={!canSubmit} className={`${primaryBtnClass} ml-auto`}>
          {submitting ? "Logging…" : "Log diagnostic run"}
        </button>
      </div>
    </form>
  );
}

function RunRow({ run, onSelect }: { run: DiagnosticRunSummary; onSelect: (id: number) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(run.id)}
      className="glass-subtle flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text-primary">{run.title}</p>
        <p className="mt-0.5 truncate text-xs text-text-muted">
          {run.service_name} · {formatRelative(run.timestamp)}
        </p>
      </div>
      <IconChevronRight className="h-3.5 w-3.5 shrink-0 text-text-muted" />
    </button>
  );
}

function RunDetailView({ id, onBack }: { id: number; onBack: () => void }) {
  const [detail, setDetail] = useState<DiagnosticRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoading(true);
    setError(null);
    getDiagnostic(id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <div className="space-y-3">
      <button type="button" onClick={onBack} className={ghostBtnClass}>
        <IconChevronLeft /> Back to runs
      </button>
      {loading && <SkeletonRow />}
      {error && <p className="text-sm text-down">{error}</p>}
      {!loading && detail && (
        <div className="glass-subtle space-y-2 p-3">
          <div>
            <h4 className="text-sm font-semibold text-text-primary">{detail.title}</h4>
            <p className="mt-0.5 text-xs text-text-muted">
              {detail.service_name} · {formatDateTime(detail.timestamp)}
              {detail.created_at !== detail.timestamp && ` · logged ${formatRelative(detail.created_at)}`}
            </p>
          </div>
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-text-secondary">
            {detail.content}
          </pre>
        </div>
      )}
    </div>
  );
}

function DiagnosticRunsTab() {
  const [services, setServices] = useState<ServiceSummary[]>([]);

  const [filterService, setFilterService] = useState("");
  const [runs, setRuns] = useState<DiagnosticRunSummary[] | null>(null);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<number | null>(null);

  useEffect(() => {
    listServices()
      .then(setServices)
      .catch((err: unknown) => console.error("Failed to load services for diagnostics form:", err));
  }, []);

  const loadRuns = useCallback(() => {
    setRunsLoading(true);
    setRunsError(null);
    listDiagnostics({ service_name: filterService || undefined, limit: 50 })
      .then(setRuns)
      .catch((err: unknown) => setRunsError(errMessage(err)))
      .finally(() => setRunsLoading(false));
  }, [filterService]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  if (selectedRunId !== null) {
    return <RunDetailView id={selectedRunId} onBack={() => setSelectedRunId(null)} />;
  }

  return (
    <div className="space-y-5">
      <section>
        <SectionHeading>New diagnostic run</SectionHeading>
        <NewRunForm services={services} onCreated={loadRuns} />
      </section>

      <section>
        <SectionHeading
          action={
            <div className="flex items-center gap-2">
              <select
                value={filterService}
                onChange={(e) => setFilterService(e.target.value)}
                aria-label="Filter by service"
                className={`${selectClass} w-auto py-1`}
              >
                <option value="">All services</option>
                {services.map((s) => (
                  <option key={s.service_name} value={s.service_name}>
                    {s.service_name}
                  </option>
                ))}
              </select>
              <button type="button" onClick={loadRuns} disabled={runsLoading} aria-label="Refresh runs" className={ghostBtnClass}>
                <IconRefresh spinning={runsLoading} />
              </button>
            </div>
          }
        >
          Past runs
        </SectionHeading>
        <div className="space-y-2">
          {runsLoading && !runs && (
            <>
              <SkeletonRow />
              <SkeletonRow />
              <SkeletonRow />
            </>
          )}
          {runsError && <p className="text-sm text-down">{runsError}</p>}
          {!runsLoading && runs && runs.length === 0 && (
            <p className="text-sm text-text-muted">No diagnostic runs logged yet.</p>
          )}
          {runs?.map((run) => (
            <RunRow key={run.id} run={run} onSelect={setSelectedRunId} />
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity Log tab
// ---------------------------------------------------------------------------

interface ActivityVisual {
  dot: string;
  primary: string;
  detail?: string;
}

function activityVisual(ev: ActivityEvent): ActivityVisual {
  if (ev.type === "status_change") {
    const status = ev.status ?? "unknown";
    const dot =
      status === "up" ? "bg-up" : status === "down" ? "bg-down" : status === "degraded" ? "bg-degraded" : "bg-unknown";
    return {
      dot,
      primary: `${ev.service_name} → ${status.toUpperCase()}`,
      detail: ev.message,
    };
  }

  // webhook_delivery
  const dot = ev.success === false ? "bg-down" : ev.success === true ? "bg-up" : "bg-unknown";
  const parts: string[] = [];
  if (ev.channel) parts.push(ev.channel);
  if (ev.http_status !== undefined) parts.push(`HTTP ${ev.http_status}`);
  if (ev.success === false) parts.push("failed");
  return {
    dot,
    primary: `${ev.service_name} → ${parts.length > 0 ? parts.join(" · ") : "webhook"}`,
    detail: ev.error,
  };
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  const visual = activityVisual(event);
  return (
    <div className="glass-subtle flex items-start gap-2.5 px-3 py-2.5">
      <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${visual.dot}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text-primary">{visual.primary}</p>
        {visual.detail && <p className="mt-0.5 truncate text-xs text-text-muted">{visual.detail}</p>}
      </div>
      <span className="shrink-0 text-xs text-text-muted" title={formatDateTime(event.timestamp)}>
        {formatRelative(event.timestamp)}
      </span>
    </div>
  );
}

function ActivityLogTab() {
  const [limit, setLimit] = useState(50);
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadActivity = useCallback((currentLimit: number) => {
    setLoading(true);
    setError(null);
    getActivity(currentLimit)
      .then(setEvents)
      .catch((err: unknown) => setError(errMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadActivity(limit);
    // Only re-run when `limit` changes (via "Load more") or on mount — a
    // manual refresh re-invokes with the same limit via the button below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit]);

  return (
    <section>
      <SectionHeading
        action={
          <button type="button" onClick={() => loadActivity(limit)} disabled={loading} aria-label="Refresh activity" className={ghostBtnClass}>
            <IconRefresh spinning={loading} />
          </button>
        }
      >
        Recent activity
      </SectionHeading>
      <div className="space-y-2">
        {loading && !events && (
          <>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </>
        )}
        {error && <p className="text-sm text-down">{error}</p>}
        {!loading && events && events.length === 0 && <p className="text-sm text-text-muted">No activity recorded yet.</p>}
        {events?.map((ev, i) => (
          <ActivityRow key={`${ev.timestamp}-${ev.service_name}-${i}`} event={ev} />
        ))}
      </div>
      {events && events.length >= limit && (
        <button type="button" onClick={() => setLimit((l) => l + 50)} disabled={loading} className={`${ghostBtnClass} mt-3 w-full justify-center`}>
          Load more
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DiagnosticsDrawer({ open, onClose }: DiagnosticsDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [entered, setEntered] = useState(false);
  const [activeTab, setActiveTab] = useState<DrawerTab>("runs");

  // ---- Entrance transition + Escape-to-close + scroll lock ----
  useEffect(() => {
    if (!open) {
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
  }, [open, onClose]);

  if (!open) return null;

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
        aria-label="Diagnostics"
        className={`glass-strong absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-hidden outline-none transition-transform duration-[var(--duration-base)] ease-out sm:max-w-xl ${
          entered ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* ---- Header ---- */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold text-text-primary">Diagnostics</h2>
            <div className="mt-2.5">
              <TabBar value={activeTab} onChange={setActiveTab} />
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close diagnostics"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover hover:text-text-primary"
          >
            <IconClose />
          </button>
        </div>

        {/* ---- Body ---- */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {activeTab === "runs" ? <DiagnosticRunsTab /> : <ActivityLogTab />}
        </div>
      </aside>
    </div>
  );
}
