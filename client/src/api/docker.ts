import { request, requestJson } from "./http.ts";
import type { DockerLogsResponse, DockerRestartResponse, DockerStatusResponse } from "./types.ts";

// Note: unlike most endpoints, a Docker-unavailable or container-not-found
// condition here is a 200 with a discriminated `available`/`detected` body
// (see DockerStatusResponse), not a thrown ApiError — only genuine HTTP
// failures (auth, 5xx) throw. Restart/logs, by contrast, do 403/404/500/503
// on those same conditions and so surface as ApiError.
export function getDockerStatus(name: string): Promise<DockerStatusResponse> {
  return request<DockerStatusResponse>(`/api/services/${encodeURIComponent(name)}/docker/status`);
}

export function restartContainer(name: string): Promise<DockerRestartResponse> {
  return requestJson<DockerRestartResponse>(`/api/services/${encodeURIComponent(name)}/docker/restart`, "POST");
}

export function getDockerLogs(name: string, tail?: number): Promise<DockerLogsResponse> {
  const qs = tail !== undefined ? `?tail=${tail}` : "";
  return request<DockerLogsResponse>(`/api/services/${encodeURIComponent(name)}/docker/logs${qs}`);
}
