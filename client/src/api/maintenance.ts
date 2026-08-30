import { request, requestJson } from "./http.ts";
import type { MaintenanceState } from "./types.ts";

export function getMaintenance(name: string): Promise<MaintenanceState> {
  return request<MaintenanceState>(`/api/services/${encodeURIComponent(name)}/maintenance`);
}

export function setMaintenance(name: string, enabled: boolean, note?: string): Promise<MaintenanceState> {
  return requestJson<MaintenanceState>(`/api/services/${encodeURIComponent(name)}/maintenance`, "PUT", {
    enabled,
    note: note ?? "",
  });
}
