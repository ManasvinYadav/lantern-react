import { request, requestJson } from "./http.ts";
import type {
  DiagnosticRunDetail,
  DiagnosticRunSummary,
  PostDiagnosticRequest,
  PostDiagnosticResponse,
} from "./types.ts";

export function postDiagnostic(body: PostDiagnosticRequest): Promise<PostDiagnosticResponse> {
  return requestJson<PostDiagnosticResponse>("/api/diagnostics", "POST", body);
}

export interface ListDiagnosticsOpts {
  service_name?: string;
  limit?: number;
  offset?: number;
}

export function listDiagnostics(opts?: ListDiagnosticsOpts): Promise<DiagnosticRunSummary[]> {
  const params = new URLSearchParams();
  if (opts?.service_name) params.set("service_name", opts.service_name);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return request<DiagnosticRunSummary[]>(`/api/diagnostics${qs ? `?${qs}` : ""}`);
}

export function getDiagnostic(id: number): Promise<DiagnosticRunDetail> {
  return request<DiagnosticRunDetail>(`/api/diagnostics/${id}`);
}
