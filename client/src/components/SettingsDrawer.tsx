// Settings drawer — a glass-strong side panel with 4 tabs: General (theme
// picker, accent picker, backup download — all built directly in this file),
// Account & Security, Alerts & Webhooks, and Monitors (each imported from
// src/components/settings/, self-contained components that take no required
// props and own their own data-fetching — see the report for why).
//
// Controlled component: `open` is the only visibility signal, mirroring
// ServiceDetailDrawer's `serviceName === null` pattern exactly. Entrance
// transition (off-screen → slide-in-from-right), Escape-to-close, and
// scroll-lock all follow that same drawer's precedent so the two panels feel
// like one family of UI.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ACCENT_PRESETS, applyAccent, getStoredAccent } from "../theme.ts";
import { getBackupUrl } from "../api/backup.ts";
import { AccountSecurityTab } from "./settings/AccountSecurityTab.tsx";
import { AlertsWebhooksTab } from "./settings/AlertsWebhooksTab.tsx";
import { MonitorsTab } from "./settings/MonitorsTab.tsx";

export interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Small local icons — same 20x20 stroke style as App.tsx / ServiceDetailDrawer.
// ---------------------------------------------------------------------------

type IconProps = { className?: string };

function IconClose({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 5l10 10M15 5L5 15" />
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

function IconDownload({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M10 3v9.5M6.2 9l3.8 3.8L13.8 9" />
      <path d="M3.5 15.5h13" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Small reusable pieces — mirrors ServiceDetailDrawer's local SectionHeading
// exactly (not imported from there: it's a private helper in that file, not
// exported, and duplicating a five-line component is cheaper than coupling
// two otherwise-independent drawers together).
// ---------------------------------------------------------------------------

function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{children}</h3>;
}

const ghostBtnClass =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50";

// ---------------------------------------------------------------------------
// General tab — accent picker + backup download. Built directly in this
// file per the task (the other three tabs are separate components under
// src/components/settings/). No theme picker: midnight is the app's only
// look, there's nothing to switch between.
// ---------------------------------------------------------------------------

function GeneralTab() {
  // Seeded from localStorage (theme.ts) once on mount — applyAccent already
  // persists on every call, so this local state only needs to track the
  // initial value plus whatever the user picks in this session; it never
  // needs to re-read storage after mount.
  const [accent, setAccent] = useState<string>(getStoredAccent);

  function handleAccentSelect(hex: string) {
    applyAccent(hex);
    setAccent(hex);
  }

  return (
    <div className="space-y-6">
      <section>
        <SectionHeading>Accent color</SectionHeading>
        <div className="flex flex-wrap gap-2.5">
          {ACCENT_PRESETS.map((hex) => {
            const selected = accent.toLowerCase() === hex.toLowerCase();
            return (
              <button
                key={hex}
                type="button"
                onClick={() => handleAccentSelect(hex)}
                aria-label={`Accent ${hex}`}
                aria-pressed={selected}
                style={{ backgroundColor: hex }}
                className={`relative h-9 w-9 shrink-0 rounded-full border-2 transition-transform duration-[var(--duration-fast)] ease-out active:scale-90 ${
                  selected ? "border-white/90 shadow-[0_0_0_3px_var(--color-panel-hover)]" : "border-transparent"
                }`}
              >
                {selected && <IconCheck className="absolute inset-0 m-auto h-4 w-4 text-white drop-shadow" />}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <SectionHeading>Backup</SectionHeading>
        <p className="mb-2.5 text-sm text-text-secondary">Download a full snapshot of the Lantern database.</p>
        {/* Plain <a download> — GET /api/backup streams a Content-Disposition
            attachment the browser handles natively (see api/backup.ts). */}
        <a href={getBackupUrl()} download className={ghostBtnClass}>
          <IconDownload /> Download backup
        </a>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

type SettingsTab = "general" | "account" | "alerts" | "monitors";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "account", label: "Account & Security" },
  { id: "alerts", label: "Alerts & Webhooks" },
  { id: "monitors", label: "Monitors" },
];

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Entrance transition: off-screen on first paint, slides in once mounted —
  // same rationale as ServiceDetailDrawer's `entered` state (a plain CSS
  // transition, not the shared `animate-banner-in` keyframe, because this is
  // a horizontal slide-in-from-right, not that keyframe's vertical fade).
  const [entered, setEntered] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");

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
        aria-label="Settings"
        className={`glass-strong absolute inset-y-0 right-0 flex w-full max-w-md flex-col overflow-hidden outline-none transition-transform duration-[var(--duration-base)] ease-out sm:max-w-xl ${
          entered ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* ---- Header ---- */}
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 className="text-lg font-semibold text-text-primary">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:bg-panel-hover hover:text-text-primary"
          >
            <IconClose />
          </button>
        </div>

        {/* ---- Tab bar ---- */}
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-5 py-2" role="tablist" aria-label="Settings sections">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors duration-[var(--duration-fast)] ease-out ${
                activeTab === tab.id
                  ? "bg-accent text-white shadow-[0_0_16px_-4px_var(--color-accent-glow)]"
                  : "text-text-secondary hover:bg-panel-hover hover:text-text-primary"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ---- Body ---- */}
        <div className="flex-1 overflow-y-auto px-5 py-5">
          {activeTab === "general" && <GeneralTab />}
          {activeTab === "account" && <AccountSecurityTab />}
          {activeTab === "alerts" && <AlertsWebhooksTab />}
          {activeTab === "monitors" && <MonitorsTab />}
        </div>
      </aside>
    </div>
  );
}
