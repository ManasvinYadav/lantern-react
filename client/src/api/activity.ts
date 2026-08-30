import { request } from "./http.ts";
import type { ActivityEvent } from "./types.ts";

export function getActivity(limit?: number): Promise<ActivityEvent[]> {
  const qs = limit !== undefined ? `?limit=${limit}` : "";
  return request<ActivityEvent[]>(`/api/activity${qs}`);
}
