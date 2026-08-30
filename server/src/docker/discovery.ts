import type Database from "better-sqlite3";
import type Dockerode from "dockerode";
import type { Config } from "../config.js";
import { ingestStatusEvent, type IngestHooks } from "../status/ingest.js";
import { DOCKER_SOCKET_PATH, createDockerClient, isDockerSocketAvailable } from "./client.js";

// Ported from docker.go dockerHealthFromStatus (~L649-663). "" means no
// healthcheck configured, which is not the same as unhealthy.
export function dockerHealthFromStatus(status: string): "healthy" | "unhealthy" | "starting" | "" {
  const s = status.toLowerCase();
  if (s.includes("(healthy)")) return "healthy";
  if (s.includes("(unhealthy)")) return "unhealthy";
  if (s.includes("health: starting")) return "starting";
  return "";
}

// Ported from docker.go dockerStatusFor (~L676-696). A running container
// whose healthcheck hasn't passed yet reports "degraded", not "up" — during
// warm-up it isn't serving, and claiming otherwise paints a green card for
// something still booting. No healthcheck at all is taken at its word.
export function dockerStatusFor(state: string, status: string): { status: string; message: string } {
  const trimmed = status.trim();
  const message = trimmed !== "" ? trimmed : `state: ${state}`;

  switch (state) {
    case "running": {
      const health = dockerHealthFromStatus(status);
      if (health === "unhealthy" || health === "starting") {
        return { status: "degraded", message };
      }
      return { status: "up", message };
    }
    case "restarting":
    case "paused":
      return { status: "degraded", message };
    case "exited":
    case "dead":
    case "created":
    case "removing":
      return { status: "down", message };
    default:
      return { status: "unknown", message };
  }
}

// Ported from docker.go dockerServiceName (~L701-711).
export function dockerServiceName(container: Dockerode.ContainerInfo): string {
  for (const rawName of container.Names ?? []) {
    const trimmed = rawName.trim().replace(/^\//, "");
    if (trimmed !== "") return trimmed;
  }
  return container.Id.length >= 12 ? container.Id.slice(0, 12) : container.Id;
}

// Ported from docker.go dockerDiscoveryIgnored (~L715-717).
export function dockerDiscoveryIgnored(labels: Record<string, string> | undefined): boolean {
  const value = (labels?.["lantern.ignore"] ?? "").trim();
  return value.toLowerCase() === "true";
}

// Ported from docker.go's package-level dockerDiscovered map + RWMutex
// (~L32-52). Node is single-threaded, so no lock is needed for correctness,
// but the "wholesale replace at end of a successful pass, leave stale
// snapshot on a failed pass" semantics are preserved.
let dockerDiscovered = new Set<string>();

export function isDockerDiscovered(serviceName: string): boolean {
  return dockerDiscovered.has(serviceName);
}

function setDockerDiscovered(seen: Set<string>): void {
  dockerDiscovered = seen;
}

// Ported from docker.go dockerDiscoveryPass (~L750-801). Every container
// comes back in one /containers/json call, so this is one request per tick
// regardless of container count; latencyMs is the daemon query round-trip
// for the whole batch, not a per-container probe time.
export async function dockerDiscoveryPass(
  client: Dockerode,
  db: Database.Database,
  hooks: IngestHooks = {}
): Promise<void> {
  const start = Date.now();

  let containers: Dockerode.ContainerInfo[];
  try {
    containers = await client.listContainers({ all: true });
  } catch (err) {
    console.error(`docker discovery: list failed: ${err}`);
    return;
  }

  const latencyMs = Date.now() - start;
  const now = new Date();
  let recorded = 0;
  let skipped = 0;
  const seen = new Set<string>();

  for (const container of containers) {
    if (dockerDiscoveryIgnored(container.Labels)) {
      skipped += 1;
      continue;
    }
    const name = dockerServiceName(container);
    if (name === "") continue;

    // Registered before the write is attempted: a transient DB error
    // should not make a container look host-sourced for a whole interval.
    seen.add(name);
    const { status, message } = dockerStatusFor(container.State, container.Status);
    try {
      ingestStatusEvent(db, name, status, message, now, latencyMs, hooks);
      recorded += 1;
    } catch (err) {
      console.error(`docker discovery: failed to record ${name}: ${err}`);
    }
  }

  setDockerDiscovered(seen);
  console.log(
    `docker discovery: recorded ${recorded} container(s), ignored ${skipped}, daemon query ${latencyMs}ms`
  );
}

// Ported from docker.go runDockerDiscovery (~L722-748). Not fatal if the
// socket is unavailable or discovery is disabled — logs and returns, the
// rest of the app boots normally either way.
export async function startDockerDiscovery(
  db: Database.Database,
  cfg: Config,
  hooks: IngestHooks = {}
): Promise<NodeJS.Timeout | null> {
  if (!cfg.dockerDiscovery) {
    console.log("docker discovery: disabled via LANTERN_DOCKER_DISCOVERY");
    return null;
  }
  if (!(await isDockerSocketAvailable())) {
    console.log(`docker discovery: ${DOCKER_SOCKET_PATH} unavailable, discovery inactive`);
    return null;
  }

  const client = createDockerClient();
  const intervalMs = cfg.dockerPollSeconds * 1000;
  console.log(`docker discovery: active, polling every ${cfg.dockerPollSeconds}s`);

  // One pass immediately, so a restart repopulates the dashboard without
  // waiting out a full interval first.
  await dockerDiscoveryPass(client, db, hooks);

  return setInterval(() => {
    void dockerDiscoveryPass(client, db, hooks);
  }, intervalMs);
}
