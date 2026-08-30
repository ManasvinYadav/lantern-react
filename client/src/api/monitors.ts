import { request, requestJson } from "./http.ts";
import type { ActiveMonitor, DeleteServiceMonitorResponse, SetServiceMonitorRequest } from "./types.ts";

export function listMonitors(): Promise<ActiveMonitor[]> {
  return request<ActiveMonitor[]>("/api/monitors");
}

/** Throws `ApiError` with status 404 when no monitor is configured for this
 * service — callers should catch and check `err.status` rather than treating
 * "no monitor" as an unexpected failure. */
export function getServiceMonitor(name: string): Promise<ActiveMonitor> {
  return request<ActiveMonitor>(`/api/services/${encodeURIComponent(name)}/monitor`);
}

export function setServiceMonitor(name: string, body: SetServiceMonitorRequest): Promise<ActiveMonitor> {
  return requestJson<ActiveMonitor>(`/api/services/${encodeURIComponent(name)}/monitor`, "PUT", body);
}

export function deleteServiceMonitor(name: string): Promise<DeleteServiceMonitorResponse> {
  return requestJson<DeleteServiceMonitorResponse>(`/api/services/${encodeURIComponent(name)}/monitor`, "DELETE");
}
