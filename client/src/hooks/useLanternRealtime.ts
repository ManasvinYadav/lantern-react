import { useCallback, useEffect, useRef, useState } from "react";
import type { HeartbeatBeat, ServiceSummary } from "../api/types";
import { listServices } from "../api/services";

// Contract with the api-client agent's output (client/src/api/services.ts):
// listServices(opts?: { public?: boolean }) hits GET /api/services or
// GET /api/public/services depending on the flag, mirroring this hook's own
// opts shape. If the real signature drifts from this, the integration pass
// reconciles the single call site below.

export type LanternConnectionStatus = "connected" | "reconnecting" | "disconnected";

export interface UseLanternRealtimeResult {
  services: ServiceSummary[];
  connectionStatus: LanternConnectionStatus;
  justUpdated: Set<string>; // service_names with an active "just updated" flash
  justBeat: Set<string>; // service_names with an active new-beat pulse
  refresh: () => Promise<void>;
}

// ~400ms new-beat pulse / ~1.2s status-update flash, per the legacy app's
// live-update-flash / beat-pulse animation windows.
const JUST_BEAT_MS = 400;
const JUST_UPDATED_MS = 1200;

const HISTORY_LIMIT = 30;

// "starting small", capped at 30s, matching the legacy reconnect strategy.
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

// A disconnect doesn't flip the UI to "disconnected" immediately — a brief
// drop/reconnect during a server restart shouldn't flash it — only after
// this much time has passed with no successful reconnect.
const DISCONNECT_GRACE_MS = 3000;

const POLL_INTERVAL_MS = 30_000;

interface HeartbeatMessage {
  type: "heartbeat";
  service_name: string;
  status: string;
  timestamp: string;
  uptime_pct: number;
  new_beat: HeartbeatBeat;
}

interface StatusUpdateMessage {
  type: "status_update";
  service: ServiceSummary;
}

function buildWsUrl(isPublic: boolean): string {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const path = isPublic ? "/api/public/ws" : "/ws";
  return `${scheme}//${window.location.host}${path}`;
}

// Shared by justUpdated/justBeat: adds a name to a Set for `durationMs`,
// resetting (not stacking) the window if a newer event arrives before the
// previous one clears.
function useTransientFlagSet(durationMs: number): [Set<string>, (name: string) => void] {
  const [flags, setFlags] = useState<Set<string>>(() => new Set());
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const mark = useCallback(
    (name: string) => {
      const existing = timers.current.get(name);
      if (existing) clearTimeout(existing);

      setFlags((prev) => (prev.has(name) ? prev : new Set(prev).add(name)));

      timers.current.set(
        name,
        setTimeout(() => {
          timers.current.delete(name);
          setFlags((prev) => {
            if (!prev.has(name)) return prev;
            const next = new Set(prev);
            next.delete(name);
            return next;
          });
        }, durationMs)
      );
    },
    [durationMs]
  );

  useEffect(() => {
    const timerMap = timers.current;
    return () => {
      for (const t of timerMap.values()) clearTimeout(t);
      timerMap.clear();
    };
  }, []);

  return [flags, mark];
}

export function useLanternRealtime(opts?: { public?: boolean }): UseLanternRealtimeResult {
  const isPublic = opts?.public ?? false;

  const [services, setServices] = useState<ServiceSummary[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<LanternConnectionStatus>("reconnecting");
  const [justUpdated, markJustUpdated] = useTransientFlagSet(JUST_UPDATED_MS);
  const [justBeat, markJustBeat] = useTransientFlagSet(JUST_BEAT_MS);

  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const disconnectGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const data = await listServices({ public: isPublic });
    setServices(data);
  }, [isPublic]);

  const handleMessage = useCallback(
    (raw: string) => {
      let msg: { type?: string };
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === "heartbeat") {
        const heartbeat = msg as HeartbeatMessage;
        setServices((prev) =>
          prev.map((s) => {
            if (s.service_name !== heartbeat.service_name) return s;
            const history =
              s.history.length >= HISTORY_LIMIT
                ? [...s.history.slice(1), heartbeat.new_beat]
                : [...s.history, heartbeat.new_beat];
            return { ...s, history, uptime_percent: heartbeat.uptime_pct };
          })
        );
        markJustBeat(heartbeat.service_name);
        return;
      }

      if (msg.type === "status_update") {
        const update = msg as StatusUpdateMessage;
        setServices((prev) => {
          const idx = prev.findIndex((s) => s.service_name === update.service.service_name);
          if (idx === -1) return [...prev, update.service];
          const next = prev.slice();
          next[idx] = update.service;
          return next;
        });
        markJustUpdated(update.service.service_name);
      }
    },
    [markJustBeat, markJustUpdated]
  );

  // WebSocket connect/reconnect lifecycle.
  useEffect(() => {
    let socket: WebSocket | null = null;
    let manualClose = false;

    const clearDisconnectGrace = () => {
      if (disconnectGraceTimerRef.current !== null) {
        clearTimeout(disconnectGraceTimerRef.current);
        disconnectGraceTimerRef.current = null;
      }
    };

    const scheduleDisconnectGrace = () => {
      if (disconnectGraceTimerRef.current !== null) return; // already counting down
      setConnectionStatus("reconnecting");
      disconnectGraceTimerRef.current = setTimeout(() => {
        disconnectGraceTimerRef.current = null;
        setConnectionStatus("disconnected");
      }, DISCONNECT_GRACE_MS);
    };

    const scheduleReconnect = () => {
      if (manualClose || reconnectTimerRef.current !== null) return;
      const attempt = reconnectAttemptRef.current;
      const backoff = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      const jittered = backoff / 2 + Math.random() * (backoff / 2);
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        reconnectAttemptRef.current = attempt + 1;
        connect();
      }, jittered);
    };

    function connect() {
      const ws = new WebSocket(buildWsUrl(isPublic));
      socket = ws;

      ws.onopen = () => {
        clearDisconnectGrace();
        reconnectAttemptRef.current = 0;
        setConnectionStatus("connected");
      };

      ws.onmessage = (event) => {
        if (typeof event.data === "string") handleMessage(event.data);
      };

      ws.onclose = () => {
        if (manualClose) return;
        scheduleDisconnectGrace();
        scheduleReconnect();
      };

      // A browser WebSocket fires 'error' immediately before 'close' on any
      // failure, so reconnection is driven from onclose alone — closing here
      // just ensures that follow-up fires promptly.
      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      manualClose = true;
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      clearDisconnectGrace();
      socket?.close();
    };
  }, [isPublic, handleMessage]);

  // Initial load + 30s correctness-backstop poll, paused while the tab is
  // hidden and immediately refetched on becoming visible again.
  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };
    const stopPolling = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    const handleVisibility = () => {
      if (document.hidden) {
        stopPolling();
        return;
      }
      void refresh();
      startPolling();
    };

    void refresh();
    if (!document.hidden) startPolling();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refresh]);

  return { services, connectionStatus, justUpdated, justBeat, refresh };
}
