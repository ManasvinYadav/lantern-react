import { existsSync, statSync } from "node:fs";
import net from "node:net";
import Dockerode from "dockerode";

// Ported from docker.go dockerSocketPath (~L72) — hardcoded, not
// env-configurable in the Go original either.
export const DOCKER_SOCKET_PATH = "/var/run/docker.sock";

export function createDockerClient(): Dockerode {
  return new Dockerode({ socketPath: DOCKER_SOCKET_PATH });
}

// Ported from docker.go isDockerSocketAvailable (~L162-173).
export async function isDockerSocketAvailable(): Promise<boolean> {
  if (!existsSync(DOCKER_SOCKET_PATH)) return false;
  try {
    if (!statSync(DOCKER_SOCKET_PATH).isSocket()) return false;
  } catch {
    return false;
  }

  return new Promise((resolve) => {
    const socket = net.createConnection({ path: DOCKER_SOCKET_PATH, timeout: 500 });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
