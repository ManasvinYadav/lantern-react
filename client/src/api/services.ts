import { apiPrefix, request, requestBlob, requestJson } from "./http.ts";
import type {
  ServiceHistoryResponse,
  ServiceIncidentsResponse,
  ServiceMetadata,
  ServiceStripResponse,
  ServiceSummary,
  ServiceUptimeResponse,
  SetServiceGroupResponse,
  UptimeRange,
} from "./types.ts";

export interface PublicOpts {
  public?: boolean;
}

export function listServices(opts?: PublicOpts): Promise<ServiceSummary[]> {
  return request<ServiceSummary[]>(`${apiPrefix(opts)}/services`);
}

export interface ServiceHistoryOpts {
  limit?: number;
  offset?: number;
}

export function getServiceHistory(name: string, opts?: ServiceHistoryOpts): Promise<ServiceHistoryResponse> {
  const params = new URLSearchParams();
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return request<ServiceHistoryResponse>(
    `/api/services/${encodeURIComponent(name)}/history${qs ? `?${qs}` : ""}`
  );
}

/** Returns the raw file body as a Blob — the caller drives the download flow
 * (e.g. an object URL + synthetic `<a download>` click) since the browser
 * can't be handed a Content-Disposition response directly from `fetch`. */
export function exportServiceHistory(name: string, format: "csv" | "json"): Promise<Blob> {
  return requestBlob(`/api/services/${encodeURIComponent(name)}/export?format=${format}`);
}

export function setServiceGroup(name: string, group: string): Promise<SetServiceGroupResponse> {
  return requestJson<SetServiceGroupResponse>(`/api/services/${encodeURIComponent(name)}/group`, "PUT", {
    group,
  });
}

export function getServiceMetadata(name: string, opts?: PublicOpts): Promise<ServiceMetadata> {
  return request<ServiceMetadata>(`${apiPrefix(opts)}/services/${encodeURIComponent(name)}/metadata`);
}

export function getServiceUptime(
  name: string,
  range: UptimeRange,
  opts?: PublicOpts
): Promise<ServiceUptimeResponse> {
  return request<ServiceUptimeResponse>(
    `${apiPrefix(opts)}/services/${encodeURIComponent(name)}/uptime?range=${range}`
  );
}

// No public mirror exists for /strip (server/src/routes/uptime.ts only
// registers it under /api/services/:name/strip) — unlike uptime/metadata,
// which are also served at /api/public/....
export function getServiceStrip(name: string, hours: number): Promise<ServiceStripResponse> {
  return request<ServiceStripResponse>(
    `/api/services/${encodeURIComponent(name)}/strip?hours=${hours}`
  );
}

// No public mirror exists for /incidents either — private-dashboard only.
export function getServiceIncidents(name: string, range: string): Promise<ServiceIncidentsResponse> {
  return request<ServiceIncidentsResponse>(
    `/api/services/${encodeURIComponent(name)}/incidents?range=${encodeURIComponent(range)}`
  );
}
