import { apiPrefix, request } from "./http.ts";
import type { GroupSummary } from "./types.ts";
import type { PublicOpts } from "./services.ts";

export function listGroups(opts?: PublicOpts): Promise<GroupSummary[]> {
  return request<GroupSummary[]>(`${apiPrefix(opts)}/groups`);
}
