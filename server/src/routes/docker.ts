import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type Dockerode from "dockerode";
import type { Config } from "../config.js";
import { createDockerClient, isDockerSocketAvailable } from "../docker/client.js";

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Ported from docker.go's repeated `container.ID[:12]` truncation (used
// throughout handleGetDockerStatus/handlePostDockerRestart/
// handleGetDockerLogs/handleGetServiceMetadata, ~L295-585). Go slices
// unconditionally since real daemon IDs are always 64 hex chars; guarded
// here the same way docker/discovery.ts's dockerServiceName already guards it.
function shortId(id: string): string {
  return id.length >= 12 ? id.slice(0, 12) : id;
}

// strconv.Atoi/ParseUint are all-or-nothing (no partial parse, unlike
// Number.parseInt) — same gap routes/services.ts's parseIntStrict documents,
// duplicated here since that one isn't exported.
function parseIntStrict(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return Number.isNaN(n) ? null : n;
}

function parseUint16Strict(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return n <= 65535 ? n : null;
}

// A rejected docker-modem call for a non-whitelisted HTTP status (as
// opposed to a transport-level failure, which rejects with a plain Error)
// carries statusCode/json/message — see node_modules/docker-modem
// lib/modem.js buildPayload. Used to tell Go's two error branches apart:
// "the daemon answered with an error" vs. "the request never got a response".
function isDockerHttpError(err: unknown): err is { statusCode: number; json: unknown; message: string } {
  return typeof err === "object" && err !== null && typeof (err as { statusCode?: unknown }).statusCode === "number";
}

// Best-effort reconstruction of Go's `string(b)` (the raw response body) —
// docker-modem already JSON-decodes the body for us, so the exact original
// bytes aren't recoverable; this renders back to text as closely as possible.
function dockerErrorBody(err: { json: unknown; message: string }): string {
  const j = err.json;
  if (typeof j === "string") return j;
  if (Buffer.isBuffer(j)) return j.toString("utf8");
  if (j !== undefined && j !== null) {
    try {
      return JSON.stringify(j);
    } catch {
      // fall through
    }
  }
  return err.message;
}

// Ported from docker.go findDockerContainer (~L139-191). Go's two-step
// list-then-decode collapses into dockerode's single listContainers() call,
// so both of Go's wrapped error cases ("failed to list containers" /
// "failed to decode containers list") collapse into one thrown Error here.
async function findDockerContainer(
  client: Dockerode,
  serviceName: string
): Promise<Dockerode.ContainerInfo | null> {
  let containers: Dockerode.ContainerInfo[];
  try {
    containers = await client.listContainers({ all: true });
  } catch (err) {
    throw new Error(`failed to list containers: ${errMessage(err)}`);
  }

  const target = serviceName.trim().toLowerCase();

  // 1. Exact match against container name (stripped of leading slash)
  for (const c of containers) {
    for (const name of c.Names ?? []) {
      if (name.replace(/^\//, "").toLowerCase() === target) return c;
    }
  }

  // 2. Compose service label match (com.docker.compose.service == target)
  for (const c of containers) {
    const label = c.Labels?.["com.docker.compose.service"];
    if (label !== undefined && label.toLowerCase() === target) return c;
  }

  // 3. Prefix/Suffix match (e.g. "lantern_app", "media-plex")
  for (const c of containers) {
    for (const name of c.Names ?? []) {
      const trimmed = name.replace(/^\//, "").toLowerCase();
      if (
        trimmed.endsWith(`_${target}`) ||
        trimmed.endsWith(`-${target}`) ||
        trimmed.startsWith(`${target}_`) ||
        trimmed.startsWith(`${target}-`)
      ) {
        return c;
      }
    }
  }

  return null;
}

const MAX_LOG_FRAME_SIZE = 10 * 1024 * 1024; // matches main.go maxLogFrameSize (~L29)

// Ported from main.go parseDockerMuxLogs (~L194-246), strips the 8-byte
// stdout/stderr multiplex header Docker's log API frames each chunk with.
// Operates over the whole Buffer dockerode's non-streaming logs() call
// already returns rather than a chunked io.Reader, so two ultra-edge cases
// that only exist because Go's io.ReadFull reuses one 8-byte scratch buffer
// across loop iterations — a truncated header immediately following one or
// more *zero-length* frames, and a total non-muxed body under 8 bytes,
// which Go's fallback pads with null bytes up to 8 — are approximated
// (returned as plain text, unpadded) rather than bit-for-bit reproduced.
// Neither is reachable with `timestamps=1` set on the request, which pads
// every real log line past 8 bytes regardless.
function parseDockerMuxLogs(data: Buffer): string {
  const parts: Buffer[] = [];
  let offset = 0;

  while (true) {
    const remaining = data.length - offset;
    if (remaining < 8) {
      if (parts.length === 0) {
        return data.toString("utf8");
      }
      break;
    }

    const streamType = data[offset];
    if (streamType !== 0 && streamType !== 1 && streamType !== 2) {
      parts.push(data.slice(offset));
      break;
    }

    const frameLen = data.readUInt32BE(offset + 4);
    offset += 8;

    if (frameLen === 0) continue;

    if (frameLen > MAX_LOG_FRAME_SIZE) {
      // Implausibly large for a real log frame — almost certainly a stream
      // desync. Copy the first MAX_LOG_FRAME_SIZE bytes through, discard the
      // declared remainder, so the next 8 bytes read are the next real header.
      const captureEnd = Math.min(offset + MAX_LOG_FRAME_SIZE, data.length);
      parts.push(data.slice(offset, captureEnd));
      const declaredEnd = offset + frameLen;
      if (declaredEnd > data.length) break;
      offset = declaredEnd;
      continue;
    }

    const frameEnd = offset + frameLen;
    if (frameEnd > data.length) {
      // Truncated final frame body — Go's io.ReadFull still writes the
      // partially-filled, zero-padded `frameLen`-sized buffer before erroring.
      const partial = data.slice(offset, data.length);
      parts.push(Buffer.concat([partial, Buffer.alloc(frameLen - partial.length)]));
      break;
    }
    parts.push(data.slice(offset, frameEnd));
    offset = frameEnd;
  }

  return Buffer.concat(parts).toString("utf8");
}

// Subset of GET /containers/{id}/json this route reads — mirrors Go's own
// DockerInspectResponse subset struct (main.go ~L50-108) rather than relying
// on @types/dockerode's ContainerInspectInfo, which omits the top-level
// NetworkSettings.IPAddress field the Go struct (and this handler) reads.
interface DockerInspectSubset {
  Created: string;
  RestartCount: number;
  State: {
    StartedAt: string;
    Health?: { Status: string } | null;
  };
  NetworkSettings: {
    IPAddress: string;
    Ports: Record<string, { HostIp: string; HostPort: string }[] | null> | null;
    Networks: Record<string, { IPAddress: string }>;
  };
  Mounts: { Type: string; Source: string; Destination: string; Mode: string; RW: boolean }[];
}

// Ported from docker.go handleGetDockerStatus/handlePostDockerRestart/
// handleGetDockerLogs/handleGetServiceMetadata (~L253-587). Registers GET
// .../docker/status, POST .../docker/restart, GET .../docker/logs, and GET
// .../metadata — private path only. The 8d7afd0 security fix deliberately
// removed the public mirror of this route (main.go ~L2178-2183): it
// returned the container image, its IP, its published ports and its host
// mount paths to anyone, unauthenticated — the same class of container
// internals isProtectedEndpoint gates /docker/* for. Do not re-add
// "/api/public/services/:name/metadata" here.
// cfg is accepted (none of the four Go handlers ported here read Config) to
// match this task's uniform registerXRoutes(app, db, cfg) signature.
export async function registerDockerRoutes(app: FastifyInstance, db: Database.Database, cfg: Config) {
  app.get<{ Params: { name: string } }>("/api/services/:name/docker/status", async (request, reply) => {
    const name = request.params.name.trim();

    if (!(await isDockerSocketAvailable())) {
      reply.send({ available: false, message: "Docker socket is not accessible" });
      return;
    }

    const client = createDockerClient();
    let container: Dockerode.ContainerInfo | null;
    try {
      container = await findDockerContainer(client, name);
    } catch (err) {
      app.log.error(err, "handleGetDockerStatus error");
      reply.send({ available: true, detected: false, error: errMessage(err) });
      return;
    }

    if (container === null) {
      reply.send({
        available: true,
        detected: false,
        message: "No matching Docker container found for service",
      });
      return;
    }

    const cleanName = container.Names.length > 0 ? container.Names[0].replace(/^\//, "") : "";

    reply.send({
      available: true,
      detected: true,
      container_id: shortId(container.Id),
      container_name: cleanName,
      image: container.Image,
      state: container.State,
      status: container.Status,
      created: container.Created,
    });
  });

  app.post<{ Params: { name: string } }>("/api/services/:name/docker/restart", async (request, reply) => {
    const name = request.params.name.trim();

    const scopedSvc = request.authContext?.scopedService;
    if (scopedSvc !== undefined && scopedSvc !== name) {
      reply.code(403).send({ error: "token not scoped for this service" });
      return;
    }

    if (!(await isDockerSocketAvailable())) {
      reply.code(503).send({ error: "Docker socket is not accessible" });
      return;
    }

    const client = createDockerClient();
    let container: Dockerode.ContainerInfo | null;
    try {
      container = await findDockerContainer(client, name);
    } catch (err) {
      reply.code(500).send({ error: `failed searching for container: ${errMessage(err)}` });
      return;
    }
    if (container === null) {
      reply.code(404).send({ error: "No matching Docker container found for service" });
      return;
    }

    try {
      // t=10: matches Go's `?t=10` restart grace-period query param.
      await client.getContainer(container.Id).restart({ t: 10 });
    } catch (err) {
      if (isDockerHttpError(err)) {
        reply
          .code(err.statusCode)
          .send({ error: `Docker returned error ${err.statusCode}: ${dockerErrorBody(err)}` });
      } else {
        reply.code(500).send({ error: `Docker restart call failed: ${errMessage(err)}` });
      }
      return;
    }

    // Go: `_, _ = db.Exec(...)` — this write's errors are deliberately
    // swallowed so a DB hiccup never turns a successful restart into a
    // failed response.
    try {
      db.prepare(
        `INSERT INTO status_events (service_name, status, message, timestamp) VALUES (?, 'up', 'Container restart initiated via Lantern Admin', ?)`
      ).run(name, new Date().toISOString());
    } catch (err) {
      app.log.error(err, "handlePostDockerRestart status insert error");
    }

    reply.send({
      status: "ok",
      message: `Container ${name} (${shortId(container.Id)}) restart initiated`,
      container_id: shortId(container.Id),
    });
  });

  app.get<{ Params: { name: string }; Querystring: { tail?: string } }>(
    "/api/services/:name/docker/logs",
    async (request, reply) => {
      const name = request.params.name.trim();

      const scopedSvc = request.authContext?.scopedService;
      if (scopedSvc !== undefined && scopedSvc !== name) {
        reply.code(403).send({ error: "token not scoped for this service" });
        return;
      }

      if (!(await isDockerSocketAvailable())) {
        reply.code(503).send({ error: "Docker socket is not accessible" });
        return;
      }

      let tail = 100;
      const tailParam = request.query.tail;
      if (tailParam) {
        const n = parseIntStrict(tailParam);
        if (n !== null && n > 0 && n <= 1000) tail = n;
      }

      const client = createDockerClient();
      let container: Dockerode.ContainerInfo | null;
      try {
        container = await findDockerContainer(client, name);
      } catch (err) {
        reply.code(500).send({ error: `failed searching container: ${errMessage(err)}` });
        return;
      }
      if (container === null) {
        reply.code(404).send({ error: "No matching Docker container found for service" });
        return;
      }

      let logsBuffer: Buffer;
      try {
        logsBuffer = await client
          .getContainer(container.Id)
          .logs({ stdout: true, stderr: true, tail, timestamps: true, follow: false });
      } catch (err) {
        if (isDockerHttpError(err)) {
          reply.code(err.statusCode).send({ error: dockerErrorBody(err) });
        } else {
          reply.code(500).send({ error: `failed reading docker logs: ${errMessage(err)}` });
        }
        return;
      }

      const parsedLogs = parseDockerMuxLogs(logsBuffer);
      const cleanName = container.Names.length > 0 ? container.Names[0].replace(/^\//, "") : "";

      reply.send({
        status: "ok",
        service_name: name,
        container_id: shortId(container.Id),
        container_name: cleanName,
        tail,
        logs: parsedLogs,
      });
    }
  );

  // Ported from docker.go handleGetServiceMetadata (~L472-587).
  // ServiceMetadataResponse's Docker-derived fields (everything past
  // docker_detected up to total_events_recorded) all carry Go's
  // `json:"...,omitempty"` tag — an empty string/zero/nil-or-empty-slice is
  // dropped from the response entirely, not sent as ""/0/null/[]. Object
  // keys below are therefore only assigned when the Go source's omitempty
  // check would have kept them, in the same struct-field order so the JSON
  // key order matches too (cosmetic, but free).
  const getMetadata = async (
    request: FastifyRequest<{ Params: { name: string } }>,
    reply: FastifyReply
  ) => {
    const name = (request.params.name ?? "").trim();
    if (name === "") {
      reply.code(400).send({ error: "service name is required" });
      return;
    }

    // Go: every one of these four reads is `_ = db.QueryRow(...).Scan(...)`
    // — errors (including real DB failures, not just "no row") are
    // deliberately swallowed and the field keeps its zero value.
    let groupName = "";
    try {
      const row = db.prepare("SELECT group_name FROM service_groups WHERE service_name = ?").get(name) as
        | { group_name: string }
        | undefined;
      groupName = row?.group_name ?? "";
    } catch {
      // swallowed, matches Go
    }

    let totalEventsRecorded = 0;
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS c FROM status_events WHERE service_name = ?")
        .get(name) as { c: number };
      totalEventsRecorded = row.c;
    } catch {
      // swallowed, matches Go
    }

    let lastSeen = "";
    try {
      const row = db
        .prepare("SELECT timestamp FROM status_events WHERE service_name = ? ORDER BY id DESC LIMIT 1")
        .get(name) as { timestamp: string } | undefined;
      lastSeen = row?.timestamp ?? "";
    } catch {
      // swallowed, matches Go
    }

    let maintenanceEnabled = false;
    try {
      const row = db.prepare("SELECT enabled FROM service_maintenance WHERE service_name = ?").get(name) as
        | { enabled: number }
        | undefined;
      maintenanceEnabled = (row?.enabled ?? 0) === 1;
    } catch {
      // swallowed, matches Go
    }

    const meta: Record<string, unknown> = {
      service_name: name,
      group_name: groupName,
      type: "host",
      docker_detected: false,
    };

    if (await isDockerSocketAvailable()) {
      const client = createDockerClient();
      let container: Dockerode.ContainerInfo | null = null;
      try {
        container = await findDockerContainer(client, name);
      } catch {
        // Go: `err == nil && container != nil` — a search failure here is
        // silently treated the same as "not found"; Type stays "host".
        container = null;
      }

      if (container !== null) {
        meta.docker_detected = true;
        meta.type = "docker";
        meta.container_id = shortId(container.Id);
        if (container.Names.length > 0) {
          const cleanName = container.Names[0].replace(/^\//, "");
          if (cleanName) meta.container_name = cleanName;
        }
        if (container.Image) meta.image = container.Image;
        if (container.State) meta.state = container.State;

        try {
          const insp = (await client.getContainer(container.Id).inspect()) as unknown as DockerInspectSubset;

          if (insp.Created) meta.created_at = insp.Created;
          if (insp.State?.StartedAt) meta.started_at = insp.State.StartedAt;
          if (insp.RestartCount) meta.restart_count = insp.RestartCount;
          if (insp.State?.Health?.Status) meta.health_status = insp.State.Health.Status;

          // Go ranges over a Go map here (NetworkSettings.Networks), whose
          // iteration order is unspecified/randomized per run; Object
          // .entries() below is deterministic (JSON key order from the
          // daemon). Same divergence for the ports loop further down.
          // Harmless in the overwhelmingly common case of one network.
          let ipAddress = insp.NetworkSettings?.IPAddress ?? "";
          let networkName = "";
          const networks = insp.NetworkSettings?.Networks ?? {};
          for (const [netName, netInfo] of Object.entries(networks)) {
            if (ipAddress === "") ipAddress = netInfo.IPAddress ?? "";
            networkName = netName;
            break;
          }
          if (ipAddress) meta.ip_address = ipAddress;
          if (networkName) meta.network_name = networkName;

          const ports: Record<string, unknown>[] = [];
          const portsMap = insp.NetworkSettings?.Ports ?? {};
          for (const [pKey, bindings] of Object.entries(portsMap)) {
            const parts = pKey.split("/");
            const cPort = parseUint16Strict(parts[0]) ?? 0;
            const pType = parts.length > 1 ? parts[1] : "tcp";

            const bindingList = bindings ?? [];
            if (bindingList.length > 0) {
              for (const b of bindingList) {
                const p: Record<string, unknown> = { container_port: cPort, type: pType };
                if (b.HostPort) p.host_port = b.HostPort;
                if (b.HostIp) p.host_ip = b.HostIp;
                ports.push(p);
              }
            } else {
              ports.push({ container_port: cPort, type: pType });
            }
          }
          if (ports.length > 0) meta.ports = ports;

          const mounts = (insp.Mounts ?? []).map((m) => ({
            type: m.Type,
            source: m.Source,
            destination: m.Destination,
            mode: m.Mode,
            rw: m.RW,
          }));
          if (mounts.length > 0) meta.mounts = mounts;
        } catch {
          // Go: inspect failure or non-200 status leaves all inspect-derived
          // fields unset (still omitted by omitempty either way).
        }
      }
    }

    meta.total_events_recorded = totalEventsRecorded;
    meta.last_seen = lastSeen;
    meta.maintenance_enabled = maintenanceEnabled;

    reply.send(meta);
  };

  app.get<{ Params: { name: string } }>("/api/services/:name/metadata", getMetadata);
}
