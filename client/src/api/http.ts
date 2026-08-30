// Shared fetch wrapper for every module under src/api/. All request paths
// are same-origin relative (e.g. "/api/services") — the Vite dev server
// proxies /api and /ws to the backend, and in production the built client is
// served by the same origin as the API, so no host is ever hardcoded here.

/** Thrown by `request()` on any non-2xx response. `body` is the parsed JSON
 * error payload when the response declared a JSON content-type and parsed
 * successfully, else the raw response text (or undefined for an empty body). */
export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

// Every server error body observed in the route files is `{ error: string }`
// (occasionally with extra fields we don't need for the message) — this just
// narrows enough to pull that string out when present.
function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string" && err !== "") return err;
  }
  return fallback;
}

/** Low-level request helper: sends credentials (the session cookie), throws
 * `ApiError` on non-2xx, and parses a JSON response body as `T`. Use for
 * every endpoint except raw-blob downloads (CSV/JSON export, backup), which
 * bypass this in favor of a direct `fetch`/`<a href>` respectively. */
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const res = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.includes("application/json");

  if (!res.ok) {
    let body: unknown;
    if (isJson) {
      body = await res.json().catch(() => undefined);
    } else {
      body = await res.text().catch(() => undefined);
    }
    throw new ApiError(res.status, extractErrorMessage(body, `${res.status} ${res.statusText}`), body);
  }

  // A handful of success responses have no body (e.g. 204s); guard against
  // res.json() throwing on empty text.
  if (res.status === 204) {
    return undefined as T;
  }
  const text = await res.text();
  if (text === "") {
    return undefined as T;
  }
  return JSON.parse(text) as T;
}

/** Convenience helper for the JSON-body write methods (PUT/POST/DELETE with
 * a body). Stringifies `body` and delegates to `request`. `headers` is an
 * escape hatch for the rare call that needs one beyond Content-Type (e.g.
 * an Authorization: Bearer header for the token-mode credentials setup —
 * see auth.ts's setupCredentials). */
export function requestJson<T>(
  path: string,
  method: string,
  body?: unknown,
  headers?: HeadersInit
): Promise<T> {
  return request<T>(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** Fetches a binary/text download (CSV/JSON export) as a Blob, applying the
 * same credentials + error-handling as `request` instead of a bare `fetch`. */
export async function requestBlob(path: string, init?: RequestInit): Promise<Blob> {
  const res = await fetch(path, { ...init, credentials: "include" });
  if (!res.ok) {
    const contentType = res.headers.get("content-type") ?? "";
    let body: unknown;
    if (contentType.includes("application/json")) {
      body = await res.json().catch(() => undefined);
    } else {
      body = await res.text().catch(() => undefined);
    }
    throw new ApiError(res.status, extractErrorMessage(body, `${res.status} ${res.statusText}`), body);
  }
  return res.blob();
}

/** Appends `{public: boolean}` opts as the "/api" vs "/api/public" prefix
 * every public-mirrored endpoint switches on. */
export function apiPrefix(opts?: { public?: boolean }): string {
  return opts?.public ? "/api/public" : "/api";
}
