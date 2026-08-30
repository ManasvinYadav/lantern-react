// Alerts & Webhooks settings tab — webhook CHANNEL configuration only.
//
// Scope note: this is deliberately NOT per-service alert routing (which
// service's status changes notify which channel) — that has a DB table but
// no route/UI yet (see CLAUDE.md's deferred-work list). This tab only
// configures the channels themselves: enable/disable + URL per channel,
// a save action, a per-channel test action, and a deliveries log.
//
// Self-contained: fetches its own data, takes no required props. Meant to be
// rendered as the content of a "Alerts & Webhooks" tab inside the (not yet
// built) Settings drawer — see ServiceDetailDrawer.tsx for this codebase's
// established drawer/section conventions, which this follows (SectionHeading-
// style headers, glass-subtle tiles, the same input/button class recipes).
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ApiError } from "../../api/http.ts";
import { getWebhookDeliveries, getWebhooks, setWebhooks, testWebhook } from "../../api/webhooks.ts";
import type {
  WebhookChannel,
  WebhookDelivery,
  WebhookTestResult,
  WebhooksResponse,
} from "../../api/types.ts";

// ---------------------------------------------------------------------------
// Channel metadata — display-only. The real per-channel data shape is just
// `{ configured, url, source }` (api/types.ts's WebhookChannelConfig): every
// channel takes exactly one field, a URL, no bot-token/chat-id/etc fields
// exist in the API. Labels/placeholders below are copy, not schema.
// ---------------------------------------------------------------------------

const CHANNEL_ORDER: WebhookChannel[] = ["discord", "telegram", "gotify", "generic"];

const CHANNEL_META: Record<WebhookChannel, { label: string; placeholder: string; hint: string }> = {
  discord: {
    label: "Discord",
    placeholder: "https://discord.com/api/webhooks/…",
    hint: "Incoming webhook URL from a Discord channel's integration settings.",
  },
  telegram: {
    label: "Telegram",
    placeholder: "https://api.telegram.org/bot…",
    hint: "Telegram bot webhook URL.",
  },
  gotify: {
    label: "Gotify",
    placeholder: "https://gotify.example.com/message?token=…",
    hint: "Gotify push message URL, including its app token.",
  },
  generic: {
    label: "Generic",
    placeholder: "https://example.com/hook",
    hint: "Any endpoint that accepts a JSON POST — for custom integrations.",
  },
};

const EMPTY_DRAFTS: Record<WebhookChannel, string> = { discord: "", telegram: "", gotify: "", generic: "" };
const ALL_HIDDEN: Record<WebhookChannel, boolean> = { discord: false, telegram: false, gotify: false, generic: false };

function draftsFromConfig(cfg: WebhooksResponse): Record<WebhookChannel, string> {
  return {
    discord: cfg.discord?.url ?? "",
    telegram: cfg.telegram?.url ?? "",
    gotify: cfg.gotify?.url ?? "",
    generic: cfg.generic?.url ?? "",
  };
}

// Whether each channel's URL field starts revealed — true for channels that
// already have a saved URL. New/unconfigured channels start hidden and the
// toggle is what reveals them for editing.
function revealedFromConfig(cfg: WebhooksResponse): Record<WebhookChannel, boolean> {
  return {
    discord: (cfg.discord?.url ?? "") !== "",
    telegram: (cfg.telegram?.url ?? "") !== "",
    gotify: (cfg.gotify?.url ?? "") !== "",
    generic: (cfg.generic?.url ?? "") !== "",
  };
}

// ---------------------------------------------------------------------------
// Formatting / error helpers (same recipe as ServiceDetailDrawer.tsx)
// ---------------------------------------------------------------------------

function errMessage(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function statusToneClass(status: string): string {
  switch (status) {
    case "up":
      return "text-up";
    case "down":
      return "text-down";
    case "degraded":
      return "text-degraded";
    default:
      return "text-unknown";
  }
}

// ---------------------------------------------------------------------------
// Small local icons — same 20x20 stroke style as App.tsx / ServiceDetailDrawer.
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function IconCheck({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M4 10.5l4 4 8-9" />
    </svg>
  );
}

function IconSend({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M17 3L2.5 9.2l5.4 2.1L10 17l2.3-4.6L17 3z" />
      <path d="M8 11.3L17 3" />
    </svg>
  );
}

function IconRefresh({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M16.5 10a6.5 6.5 0 1 1-2.1-4.8" />
      <path d="M16.5 3.5v3.6h-3.6" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Small reusable pieces (mirrors ServiceDetailDrawer.tsx's helpers)
// ---------------------------------------------------------------------------

function SectionHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{children}</h3>
      {action}
    </div>
  );
}

function SkeletonTile() {
  return <div className="glass-subtle h-[76px] animate-shimmer" aria-hidden="true" />;
}

const inputClass =
  "w-full min-w-0 rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-xs text-text-primary outline-none transition-colors duration-[var(--duration-fast)] ease-out placeholder:text-text-muted placeholder:font-sans focus:border-border-focus disabled:cursor-not-allowed disabled:opacity-50";

const primaryBtnClass =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-transform duration-[var(--duration-fast)] ease-out active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50";

const ghostBtnClass =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";

function ToggleSwitch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onChange}
      disabled={disabled}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors duration-[var(--duration-fast)] ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "border-accent/40 bg-accent" : "border-[#4a4d57] bg-[#3a3d46]"
      }`}
    >
      <span
        className={`absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow-sm transition-transform duration-[var(--duration-fast)] ease-out ${
          checked ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Per-channel test state
// ---------------------------------------------------------------------------

type TestState = { status: "idle" } | { status: "pending" } | { status: "done"; result: WebhookTestResult };

function describeTestResult(r: WebhookTestResult): { tone: "up" | "down" | "muted"; text: string } {
  if (!r.attempted) {
    return { tone: "muted", text: r.message || "Not attempted — no URL configured." };
  }
  if ("status_code" in r) {
    // WebhookTestCompleted — request completed, success reflects whether the
    // endpoint accepted it.
    return r.success
      ? { tone: "up", text: `Delivered · HTTP ${r.status_code}` }
      : { tone: "down", text: `Rejected · HTTP ${r.status_code}` };
  }
  // WebhookTestTransportFailure — request never got an HTTP response.
  return { tone: "down", text: r.message };
}

function TestResultLine({ state }: { state: TestState }) {
  if (state.status === "idle") return null;
  if (state.status === "pending") {
    return <p className="text-xs text-text-muted">Sending test…</p>;
  }
  const { tone, text } = describeTestResult(state.result);
  const cls = tone === "up" ? "text-up" : tone === "down" ? "text-down" : "text-text-muted";
  return <p className={`text-xs ${cls}`}>{text}</p>;
}

// ---------------------------------------------------------------------------
// Deliveries log
// ---------------------------------------------------------------------------

const DELIVERY_LIMITS = [25, 50, 100] as const;

function DeliveryRow({ d }: { d: WebhookDelivery }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-xs">
      <span className="w-[124px] shrink-0 text-text-muted">{formatDateTime(d.created_at)}</span>
      <span className="w-[70px] shrink-0 truncate font-medium capitalize text-text-primary">{d.channel}</span>
      <span className="min-w-0 flex-1 truncate text-text-secondary">
        <span className="text-text-primary">{d.service_name}</span>{" "}
        <span className={statusToneClass(d.old_status)}>{d.old_status}</span>
        {" → "}
        <span className={statusToneClass(d.new_status)}>{d.new_status}</span>
      </span>
      <span className={`w-[90px] shrink-0 font-medium ${d.success ? "text-up" : "text-down"}`}>
        {d.success ? "Delivered" : "Failed"}
        {d.http_status ? ` · ${d.http_status}` : ""}
      </span>
      {!d.success && d.error && <span className="w-full truncate text-[11px] text-down/80 sm:w-auto sm:flex-1">{d.error}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AlertsWebhooksTab() {
  const idPrefix = useId();

  // Channel config: server-canonical state + the editable draft.
  const [config, setConfig] = useState<WebhooksResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<WebhookChannel, string>>(EMPTY_DRAFTS);
  const [revealed, setRevealed] = useState<Record<WebhookChannel, boolean>>(ALL_HIDDEN);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Remembers the last non-empty URL typed per channel so toggling a channel
  // off (which clears its draft to "", the delete signal) and back on
  // restores what was there instead of losing it.
  const lastValueRef = useRef<Record<WebhookChannel, string>>({ ...EMPTY_DRAFTS });

  // Save.
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-channel test.
  const [testStates, setTestStates] = useState<Record<WebhookChannel, TestState>>({
    discord: { status: "idle" },
    telegram: { status: "idle" },
    gotify: { status: "idle" },
    generic: { status: "idle" },
  });

  // Deliveries log.
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(true);
  const [deliveriesError, setDeliveriesError] = useState<string | null>(null);
  const [deliveriesLimit, setDeliveriesLimit] = useState<number>(50);

  // ---- Load channel config ----
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    getWebhooks()
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        const next = draftsFromConfig(cfg);
        setDrafts(next);
        setRevealed(revealedFromConfig(cfg));
        lastValueRef.current = { ...next };
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Load deliveries (refetches on limit change) ----
  const loadDeliveries = useCallback((limit: number) => {
    setDeliveriesLoading(true);
    setDeliveriesError(null);
    getWebhookDeliveries(limit)
      .then((rows) => setDeliveries(rows))
      .catch((err: unknown) => setDeliveriesError(errMessage(err)))
      .finally(() => setDeliveriesLoading(false));
  }, []);

  useEffect(() => {
    loadDeliveries(deliveriesLimit);
  }, [loadDeliveries, deliveriesLimit]);

  useEffect(() => {
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  // ---- Derived: which channels differ from the saved config ----
  const dirtyChannels = useMemo(() => {
    if (!config) return [];
    return CHANNEL_ORDER.filter((id) => drafts[id] !== (config[id]?.url ?? ""));
  }, [drafts, config]);

  // ---- Handlers ----

  function handleUrlChange(id: WebhookChannel, value: string) {
    setDrafts((prev) => ({ ...prev, [id]: value }));
    setSaved(false);
  }

  function handleToggle(id: WebhookChannel) {
    setRevealed((prev) => {
      const next = !prev[id];
      setDrafts((prevDrafts) => {
        const current = prevDrafts[id];
        if (!next) {
          // Turning off: stash whatever was typed so turning back on restores
          // it, then clear the draft — an empty draft is the delete signal.
          if (current.trim() !== "") lastValueRef.current[id] = current;
          return { ...prevDrafts, [id]: "" };
        }
        // Turning on: restore the last-known value if there is one, otherwise
        // just open the field empty and ready to type into.
        return { ...prevDrafts, [id]: lastValueRef.current[id] ?? "" };
      });
      return { ...prev, [id]: next };
    });
    setSaved(false);
  }

  async function handleSave() {
    if (saving || dirtyChannels.length === 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Multi-channel map form of SetWebhooksRequest — only send channels
      // that actually changed; an empty url deletes that channel's saved
      // config, an omitted key leaves it untouched.
      const payload: Record<string, string> = {};
      for (const id of dirtyChannels) payload[id] = drafts[id];
      await setWebhooks(payload);
      const fresh = await getWebhooks();
      setConfig(fresh);
      const next = draftsFromConfig(fresh);
      setDrafts(next);
      setRevealed(revealedFromConfig(fresh));
      lastValueRef.current = { ...next };
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setSaveError(errMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleTest(id: WebhookChannel) {
    setTestStates((prev) => ({ ...prev, [id]: { status: "pending" } }));
    try {
      const res = await testWebhook(id);
      const result = res.results[id];
      setTestStates((prev) => ({
        ...prev,
        [id]: {
          status: "done",
          result: result ?? { attempted: false, source: "none", message: "No result returned for this channel." },
        },
      }));
    } catch (err) {
      setTestStates((prev) => ({
        ...prev,
        [id]: { status: "done", result: { attempted: false, source: "none", message: errMessage(err) } },
      }));
    }
  }

  return (
    <div className="space-y-6">
      {/* ---- Channels ---- */}
      <section>
        <SectionHeading
          action={
            <button type="button" onClick={() => void handleSave()} disabled={saving || dirtyChannels.length === 0} className={primaryBtnClass}>
              {saving ? (
                "Saving…"
              ) : saved ? (
                <>
                  <IconCheck /> Saved
                </>
              ) : (
                `Save${dirtyChannels.length > 0 ? ` (${dirtyChannels.length})` : ""}`
              )}
            </button>
          }
        >
          Channels
        </SectionHeading>
        <p className="mb-3 text-xs text-text-secondary">
          Configure where status-change alerts get delivered. Enabling a channel without a saved URL just opens the field for
          editing — nothing is deleted until you save.
        </p>

        {loading && (
          <div className="space-y-2.5">
            <SkeletonTile />
            <SkeletonTile />
            <SkeletonTile />
            <SkeletonTile />
          </div>
        )}

        {!loading && loadError && <p className="text-sm text-down">{loadError}</p>}

        {!loading && !loadError && config && (
          <div className="space-y-2.5">
            {CHANNEL_ORDER.map((id) => {
              const meta = CHANNEL_META[id];
              const channelConfig = config[id];
              const enabled = revealed[id];
              const savedUrl = channelConfig?.url ?? "";
              const isDirty = drafts[id] !== savedUrl;
              const inputId = `${idPrefix}-${id}-url`;

              return (
                <div key={id} className="glass-subtle space-y-2.5 p-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <label htmlFor={inputId} className="text-sm font-medium text-text-primary">
                          {meta.label}
                        </label>
                        {channelConfig?.configured && (
                          <span className="rounded-full border border-border bg-panel-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-text-muted">
                            via {channelConfig.source}
                          </span>
                        )}
                        {isDirty && (
                          <span className="rounded-full border border-accent/30 bg-accent-bg px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                            unsaved
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 text-[11px] text-text-muted">{meta.hint}</p>
                    </div>
                    <ToggleSwitch checked={enabled} onChange={() => handleToggle(id)} label={`${meta.label} enabled`} />
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      id={inputId}
                      type="text"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      value={drafts[id]}
                      onChange={(e) => handleUrlChange(id, e.target.value)}
                      placeholder={meta.placeholder}
                      disabled={!enabled}
                      className={inputClass}
                    />
                    <button type="button" onClick={() => void handleTest(id)} disabled={testStates[id].status === "pending"} className={ghostBtnClass}>
                      <IconSend /> {testStates[id].status === "pending" ? "Sending…" : "Send Test"}
                    </button>
                  </div>
                  <TestResultLine state={testStates[id]} />
                </div>
              );
            })}
          </div>
        )}

        {saveError && <p className="mt-2.5 text-xs text-down">{saveError}</p>}
      </section>

      {/* ---- Deliveries log ---- */}
      <section>
        <SectionHeading
          action={
            <div className="flex items-center gap-2">
              <select
                value={deliveriesLimit}
                onChange={(e) => setDeliveriesLimit(Number(e.target.value))}
                aria-label="Number of deliveries to show"
                className="rounded-md border border-border bg-bg px-2 py-1 text-[11px] text-text-secondary outline-none focus:border-border-focus"
              >
                {DELIVERY_LIMITS.map((n) => (
                  <option key={n} value={n}>
                    Last {n}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => loadDeliveries(deliveriesLimit)}
                disabled={deliveriesLoading}
                aria-label="Refresh deliveries"
                className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover hover:text-text-primary disabled:opacity-50"
              >
                <IconRefresh />
              </button>
            </div>
          }
        >
          Deliveries
        </SectionHeading>

        {deliveriesLoading && deliveries.length === 0 && (
          <div className="space-y-2">
            <SkeletonTile />
            <SkeletonTile />
          </div>
        )}

        {!deliveriesLoading && deliveriesError && <p className="text-sm text-down">{deliveriesError}</p>}

        {!deliveriesError && !(deliveriesLoading && deliveries.length === 0) && deliveries.length === 0 && (
          <p className="text-sm text-text-muted">No webhook deliveries recorded yet.</p>
        )}

        {!deliveriesError && deliveries.length > 0 && (
          <div className="glass-subtle max-h-80 divide-y divide-border overflow-y-auto">
            {deliveries.map((d) => (
              <DeliveryRow key={d.id} d={d} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export default AlertsWebhooksTab;
