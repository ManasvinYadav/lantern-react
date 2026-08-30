import websocketPlugin from "@fastify/websocket";
import type { WebSocket } from "@fastify/websocket";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import { buildServiceSummary } from "../services/summary.js";
import type { HeartbeatBeat, ServiceSummary } from "../services/summary.js";

// Ported from main.go's const block (~L521-525).
const WS_WRITE_WAIT_MS = 10_000;
const WS_PONG_WAIT_MS = 60_000;
const WS_PING_PERIOD_MS = Math.floor((WS_PONG_WAIT_MS * 9) / 10);
// Ported from main.go handleWS (~L581): `make(chan []byte, 16)`.
const WS_SEND_BUFFER_SIZE = 16;

interface WsClient {
  socket: WebSocket;
  // Bounded outbound queue mirroring Go's `send chan []byte` (cap 16).
  queue: string[];
  writing: boolean;
  pingPending: boolean;
  pongDeadline: ReturnType<typeof setTimeout>;
  pingTimer: ReturnType<typeof setInterval>;
  closed: boolean;
}

// Ported from main.go wsHub (~L474-477, extended ~L489-500 by the 8d7afd0
// security fix): tracks connected clients for broadcast fan-out. Node is
// single-threaded, so the Go struct's sync.RWMutex has no equivalent here.
// `public` is the unauthenticated hub behind /api/public/ws, null on the
// public hub itself — see broadcastServiceUpdate for why this must stay a
// separate fan-out set fed a reduced payload rather than sharing clients
// with the gated hub (CVE-level bug: the session gate on /ws bought nothing
// if an anonymous client could get byte-identical data via /api/public/ws).
export interface WsHub {
  clients: Set<WsClient>;
  public: WsHub | null;
}

// Ported from main.go newWSHub (~L479-481, extended by 8d7afd0).
export function createWsHub(): WsHub {
  return { clients: new Set(), public: { clients: new Set(), public: null } };
}

// Ported from main.go wsHub.broadcast (~L501-511): fans a message out to
// every connected client, skipping (never blocking on) one whose outbound
// queue is full so a stuck client can't stall the broadcaster.
function broadcast(hub: WsHub, msg: string): void {
  for (const client of hub.clients) {
    enqueue(client, msg);
  }
}

function enqueue(client: WsClient, msg: string): void {
  if (client.closed) return;
  if (client.queue.length >= WS_SEND_BUFFER_SIZE) {
    console.log("ws: client send buffer full, dropping message");
    return;
  }
  client.queue.push(msg);
  pump(client);
}

// Single-flight writer for one client, standing in for the Go writePump
// goroutine's `select` loop: at most one outbound frame (ping or queued
// message) is ever in flight at a time, each bounded by the same write-wait
// timeout Go applies via SetWriteDeadline.
function pump(client: WsClient): void {
  if (client.writing || client.closed) return;
  if (client.pingPending) {
    client.pingPending = false;
    write(client, { kind: "ping" });
    return;
  }
  const next = client.queue.shift();
  if (next === undefined) return;
  write(client, { kind: "message", data: next });
}

function write(client: WsClient, action: { kind: "ping" } | { kind: "message"; data: string }): void {
  client.writing = true;
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    client.writing = false;
    // Write-wait exceeded: treat like Go's WriteMessage returning an error
    // and abandon the connection.
    client.socket.terminate();
  }, WS_WRITE_WAIT_MS);

  const done = (err?: Error | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    client.writing = false;
    if (err) {
      client.socket.terminate();
      return;
    }
    pump(client);
  };

  try {
    if (action.kind === "ping") {
      client.socket.ping(done);
    } else {
      client.socket.send(action.data, done);
    }
  } catch {
    done(new Error("ws send threw"));
  }
}

// Ported from main.go readPump's deferred cleanup (~L554-557) plus
// wsHub.unregister (~L489-496). The only path that removes a client in Go
// is the read side noticing the connection is dead; here that's either the
// pong-wait timer firing or the socket's own 'close'/'error' events, so
// this is written idempotent (both can fire for the same disconnect).
function unregisterClient(hub: WsHub, client: WsClient): void {
  if (client.closed) return;
  client.closed = true;
  clearInterval(client.pingTimer);
  clearTimeout(client.pongDeadline);
  hub.clients.delete(client);
  client.queue.length = 0;
  client.socket.terminate();
}

function resetPongDeadline(hub: WsHub, client: WsClient): void {
  clearTimeout(client.pongDeadline);
  // Ported from readPump's SetReadDeadline/SetPongHandler (~L558-562): only
  // a received pong pushes the deadline forward, exactly as in the Go
  // version — ordinary data frames from the client do not.
  client.pongDeadline = setTimeout(() => unregisterClient(hub, client), WS_PONG_WAIT_MS);
}

// Ported from main.go handleWS (~L574-586): upgrades and registers one
// client, wiring up the writePump/readPump equivalents (ping/pong keepalive
// + bounded outbound queue) around Node's event loop instead of literal
// goroutines.
function handleConnection(hub: WsHub, socket: WebSocket): void {
  const client: WsClient = {
    socket,
    queue: [],
    writing: false,
    pingPending: false,
    pongDeadline: setTimeout(() => {}, 0),
    pingTimer: setInterval(() => {}, 0),
    closed: false,
  };
  clearTimeout(client.pongDeadline);
  clearInterval(client.pingTimer);

  hub.clients.add(client);

  resetPongDeadline(hub, client);
  client.pingTimer = setInterval(() => {
    client.pingPending = true;
    pump(client);
  }, WS_PING_PERIOD_MS);

  socket.on("pong", () => resetPongDeadline(hub, client));
  socket.on("close", () => unregisterClient(hub, client));
  socket.on("error", () => unregisterClient(hub, client));
  // Clients don't send anything meaningful; we only listen for
  // disconnects/control frames above, matching readPump's comment
  // (~L564-565) — no 'message' handler is registered.
}

// Ported from main.go setupRoutes (~L1850-1851, ~L2108-2112 post-8d7afd0):
// "/ws" uses the gated hub, "/api/public/ws" uses its separate `public`
// sub-hub — deliberately different client sets, not the same handler wired
// twice, so a field added to the gated broadcast can't leak onto the open
// one by accident (see broadcastServiceUpdate). wsUpgrader's CheckOrigin
// (~L518) always returns true in Go; @fastify/websocket performs no origin
// check by default, which is already that same permissive behavior, so no
// options are passed here to restrict it.
export async function registerWsRoutes(app: FastifyInstance, hub: WsHub): Promise<void> {
  await app.register(websocketPlugin);

  app.get("/ws", { websocket: true }, (socket) => {
    handleConnection(hub, socket);
  });

  const publicHub = hub.public;
  app.get("/api/public/ws", { websocket: true }, (socket) => {
    if (publicHub) handleConnection(publicHub, socket);
  });
}

interface WsHeartbeatMessage {
  type: "heartbeat";
  service_name: string;
  status: string;
  timestamp: string;
  uptime_pct: number;
  new_beat: HeartbeatBeat;
}

interface WsMessage {
  type: "status_update";
  service: ServiceSummary;
}

// Ported from main.go wsPublicService/wsPublicMessage/publicViewOf
// (added by 8d7afd0, ~L634-670): the reduced view broadcast on
// /api/public/ws. Spelled out field by field rather than reusing
// ServiceSummary so that anything added to the gated feed has to be added
// here deliberately before it reaches anonymous listeners — `history` is
// deliberately absent (the public status page has no heartbeat bar to feed).
interface WsPublicService {
  service_name: string;
  status: string;
  message: string;
  timestamp: string;
  last_seen: string;
  stale: boolean;
  maintenance: boolean;
  group_name: string;
  uptime_7d: number;
  uptime_30d: number;
  uptime_percent: number;
  monitor_type: string;
  source: string;
}

interface WsPublicMessage {
  type: "status_update";
  service: WsPublicService;
}

function publicViewOf(s: ServiceSummary): WsPublicService {
  return {
    service_name: s.service_name,
    status: s.status,
    message: s.message,
    timestamp: s.timestamp,
    last_seen: s.last_seen,
    stale: s.stale,
    maintenance: s.maintenance,
    group_name: s.group_name,
    uptime_7d: s.uptime_7d,
    uptime_30d: s.uptime_30d,
    uptime_percent: s.uptime_percent,
    monitor_type: s.monitor_type,
    source: s.source,
  };
}

// Ported from main.go broadcastServiceUpdate (~L647-679, extended by
// 8d7afd0 ~L752-766): builds the current summary for a service and pushes
// it to every connected client. The lightweight heartbeat delta is
// broadcast first, then the fuller status_update, matching Go's ordering
// exactly — both go ONLY to the gated hub. The public hub gets a
// status_update only, with the reduced envelope, and no heartbeat frame at
// all (see WsPublicService).
export function broadcastServiceUpdate(
  hub: WsHub,
  db: Database.Database,
  cfg: Config,
  serviceName: string
): void {
  const summary = buildServiceSummary(db, cfg, serviceName);
  if (!summary) return;

  if (summary.history.length > 0) {
    const heartbeat: WsHeartbeatMessage = {
      type: "heartbeat",
      service_name: summary.service_name,
      status: summary.status,
      timestamp: summary.timestamp,
      uptime_pct: summary.uptime_percent,
      new_beat: summary.history[summary.history.length - 1],
    };
    broadcast(hub, JSON.stringify(heartbeat));
  }

  const statusUpdate: WsMessage = { type: "status_update", service: summary };
  broadcast(hub, JSON.stringify(statusUpdate));

  if (hub.public) {
    const publicUpdate: WsPublicMessage = { type: "status_update", service: publicViewOf(summary) };
    broadcast(hub.public, JSON.stringify(publicUpdate));
  }
}
