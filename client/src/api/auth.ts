import { request, requestJson } from "./http.ts";
import type {
  AuthSession,
  LoginResponse,
  LogoutResponse,
  SetupCredentialsRequest,
  SetupCredentialsResponse,
} from "./types.ts";

export function getSession(): Promise<AuthSession> {
  return request<AuthSession>("/api/auth/session");
}

/** Throws `ApiError` (401 invalid credentials, 429 rate-limited, 400 no
 * credentials configured) on failure — the session cookie is set as a
 * side effect of the response on success, nothing to store client-side. */
export function login(username: string, password: string): Promise<LoginResponse> {
  return requestJson<LoginResponse>("/api/auth/login", "POST", { username, password });
}

export function logout(): Promise<LogoutResponse> {
  return requestJson<LogoutResponse>("/api/auth/logout", "POST");
}

/** Same endpoint serves both first-run setup (no `current_password` needed,
 * gated instead by `can_setup`/the admin token per getSession()) and a
 * logged-in credentials change (`current_password` required).
 *
 * `adminToken` is required by middleware.ts's setup-time check whenever
 * `token_mode` is true (an admin bearer token is already configured but no
 * username/password pair exists yet): the route checks
 * `request.authContext?.isAdmin`, which only the Bearer-token path sets, so
 * the token must travel as an Authorization header — it is never accepted
 * as a body field. */
export function setupCredentials(
  body: SetupCredentialsRequest,
  adminToken?: string
): Promise<SetupCredentialsResponse> {
  const headers = adminToken ? { Authorization: `Bearer ${adminToken}` } : undefined;
  return requestJson<SetupCredentialsResponse>("/api/auth/credentials", "PUT", body, headers);
}
