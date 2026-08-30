// Cmd/Ctrl+K command palette — a centered glass-strong overlay for jumping
// straight to a service's detail drawer by name.
//
// Fully controlled: this component owns none of the state that decides
// *whether* it's open. There is no `onOpen` callback in the prop interface
// below (only `onClose`), so it has no way to announce "please open me" even
// if it listened for Cmd/Ctrl+K itself — that decision necessarily lives
// with whoever owns the `open` boolean (the integration phase / App.tsx),
// which should add its own `document`-level keydown listener that flips
// `open` to true on Cmd/Ctrl+K. This component's own keyboard handling
// (Escape to close, Up/Down to move the highlight, Enter to select) is
// scoped to only run while `open` is already true.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ServiceSummary } from "../api/types.ts";

export interface CommandPaletteProps {
  /** Full service list to search over (unfiltered — this component does its
   * own case-insensitive substring match against `service_name`). */
  services: ServiceSummary[];
  /** Whether the palette is currently shown. Owned by the caller. */
  open: boolean;
  /** Called on Escape, backdrop click, or after a selection is made. */
  onClose: () => void;
  /** Called with the chosen service's `service_name` when a result is
   * picked (click or Enter on the highlighted row). The caller is expected
   * to open that service's detail drawer; this component calls `onClose`
   * immediately after, in the same handler. */
  onSelectService: (serviceName: string) => void;
}

function IconSearch({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <line x1="16.5" y1="16.5" x2="12.6" y2="12.6" />
    </svg>
  );
}

// Status/maintenance -> dot color. Mirrors the server's literal status
// vocabulary (server/src/routes/status.ts VALID_STATUSES: up/down/degraded/
// unknown) plus the separate `maintenance` boolean, which takes visual
// priority over whatever `status` currently reads.
function statusDotClass(service: ServiceSummary): string {
  if (service.maintenance) return "bg-maint";
  switch (service.status) {
    case "up":
      return "bg-up";
    case "down":
      return "bg-down";
    case "degraded":
      return "bg-degraded";
    default:
      return "bg-unknown";
  }
}

export function CommandPalette({ services, open, onClose, onSelectService }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return services;
    return services.filter((s) => s.service_name.toLowerCase().includes(q));
  }, [services, query]);

  // Reset search + highlight and autofocus the input every time the palette
  // opens, so a prior session's leftover query never greets the next open.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHighlighted(0);
    const id = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Keep the highlighted index in range as filtering shrinks/grows the
  // result set (e.g. typing narrows 12 results down to 2).
  useEffect(() => {
    setHighlighted((h) => (results.length === 0 ? 0 : Math.min(h, results.length - 1)));
  }, [results.length]);

  // Escape / Up / Down / Enter — scoped to a document listener only while
  // open, so this never intercepts keystrokes elsewhere in the app.
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlighted((h) => (results.length === 0 ? 0 : (h + 1) % results.length));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlighted((h) => (results.length === 0 ? 0 : (h - 1 + results.length) % results.length));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const target = results[highlighted];
        if (target) {
          onSelectService(target.service_name);
          onClose();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, results, highlighted, onClose, onSelectService]);

  if (!open) return null;

  function handleSelect(serviceName: string) {
    onSelectService(serviceName);
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh] font-sans" role="presentation">
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        aria-hidden="true"
        onClick={onClose}
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="glass-strong relative z-10 flex w-full max-w-lg flex-col overflow-hidden"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <IconSearch className="h-4 w-4 shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search services…"
            aria-label="Search services"
            aria-controls="command-palette-results"
            aria-activedescendant={results[highlighted] ? `command-palette-option-${results[highlighted].service_name}` : undefined}
            role="combobox"
            aria-expanded="true"
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-transparent text-md text-text-primary outline-none placeholder:text-text-muted"
          />
          <kbd className="hidden shrink-0 rounded border border-border bg-panel-bg px-1.5 py-0.5 font-mono text-xs text-text-muted sm:inline-block">
            Esc
          </kbd>
        </div>

        <ul id="command-palette-results" role="listbox" aria-label="Services" className="max-h-80 overflow-y-auto p-2">
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-text-muted">
              {services.length === 0 ? "No services yet." : `No services match "${query}"`}
            </li>
          ) : (
            results.map((service, index) => (
              <li
                key={service.service_name}
                id={`command-palette-option-${service.service_name}`}
                role="option"
                aria-selected={index === highlighted}
              >
                <button
                  type="button"
                  onClick={() => handleSelect(service.service_name)}
                  onMouseEnter={() => setHighlighted(index)}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors duration-[var(--duration-fast)] ease-out ${
                    index === highlighted
                      ? "bg-panel-hover text-text-primary"
                      : "text-text-secondary hover:bg-panel-hover hover:text-text-primary"
                  }`}
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusDotClass(service)}`} aria-hidden="true" />
                  <span className="truncate">{service.service_name}</span>
                  {service.group_name !== "" && (
                    <span className="ml-auto shrink-0 truncate text-xs text-text-muted">{service.group_name}</span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

export default CommandPalette;
