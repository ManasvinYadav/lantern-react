// Session-auth state machine + public/private mode switch for the whole
// app. A provider (not a bare hook) because login/logout/setup all need to
// update state that many unrelated components read (LoginForm,
// CredentialsSetupForm, a future Settings drawer's logout button, the
// Shell's top-level render decision) — one fetch of GET /api/auth/session,
// shared everywhere via context.
//
// ".tsx" (not ".ts") because AuthProvider renders JSX; this is the file the
// task's FILES TO CREATE list names "useAuth.ts", written as a provider +
// hook pair per the task's own "your call" — see the report for why.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getSession, login as apiLogin, logout as apiLogout, setupCredentials as apiSetupCredentials } from "../api/auth.ts";
import type { AuthSession } from "../api/types.ts";

export type AuthStatus = "loading" | "gate-login" | "authenticated" | "open" | "public";

export interface SetupCredentialsInput {
  new_username: string;
  new_password: string;
  /** Required (and only meaningful) when `tokenMode` is true — see
   * api/auth.ts's setupCredentials for why this travels as a header, not a
   * body field. */
  admin_token?: string;
}

export interface AuthContextValue {
  status: AuthStatus;
  username?: string;
  canSetup: boolean;
  tokenMode: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  setupCredentials: (input: SetupCredentialsInput) => Promise<void>;
  enterPublicMode: () => void;
  exitPublicMode: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Used only if GET /api/auth/session itself throws (network failure, 5xx) —
// never inferred from a real response body. Failing closed to the login
// gate is the safe default on an indeterminate backend: it never exposes
// mutating UI, where defaulting to "open" would.
const SESSION_FETCH_FAILED: AuthSession = {
  auth_required: true,
  authenticated: false,
  token_mode: false,
  can_setup: false,
};

function readPublicQueryParam(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("public") === "1";
}

// Adds/removes "?public=1" without touching any other query params or
// triggering navigation — enterPublicMode/exitPublicMode call this so a
// reload (or a shared link) preserves the mode the same way the initial
// mount's readPublicQueryParam() read it.
function setPublicQueryParam(isPublic: boolean): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (isPublic) {
    url.searchParams.set("public", "1");
  } else {
    url.searchParams.delete("public");
  }
  window.history.replaceState(null, "", url);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AuthSession | null>(null);
  // Seeded once from the URL; from then on only enterPublicMode/
  // exitPublicMode touch it, so a session refetch (e.g. after login) can
  // never silently flip the app out of public mode underneath the viewer.
  const [publicMode, setPublicMode] = useState<boolean>(readPublicQueryParam);

  useEffect(() => {
    let cancelled = false;
    getSession()
      .then((s) => {
        if (!cancelled) setSession(s);
      })
      .catch((err: unknown) => {
        console.error("Failed to load auth session:", err);
        if (!cancelled) setSession(SESSION_FETCH_FAILED);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const enterPublicMode = useCallback(() => {
    setPublicMode(true);
    setPublicQueryParam(true);
  }, []);

  const exitPublicMode = useCallback(() => {
    setPublicMode(false);
    setPublicQueryParam(false);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const result = await apiLogin(username, password);
    setSession((prev) => ({
      auth_required: true,
      authenticated: true,
      username: result.username,
      token_mode: prev?.token_mode ?? false,
      can_setup: false,
    }));
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setSession((prev) => ({
      auth_required: prev?.auth_required ?? true,
      authenticated: false,
      username: undefined,
      token_mode: prev?.token_mode ?? false,
      can_setup: prev?.can_setup ?? false,
    }));
  }, []);

  const setupCredentials = useCallback(async (input: SetupCredentialsInput) => {
    const result = await apiSetupCredentials(
      { new_username: input.new_username, new_password: input.new_password },
      input.admin_token
    );
    // The route rotates every session and hands back a fresh cookie for
    // this tab (routes.ts), and a username/password pair now exists, so
    // auth_required flips true and can_setup false without a refetch.
    setSession((prev) => ({
      auth_required: true,
      authenticated: true,
      username: result.username,
      token_mode: prev?.token_mode ?? false,
      can_setup: false,
    }));
  }, []);

  const status: AuthStatus = useMemo(() => {
    if (publicMode) return "public";
    if (session === null) return "loading";
    if (!session.auth_required) return "open";
    return session.authenticated ? "authenticated" : "gate-login";
  }, [publicMode, session]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      username: session?.username,
      canSetup: session?.can_setup ?? false,
      tokenMode: session?.token_mode ?? false,
      login,
      logout,
      setupCredentials,
      enterPublicMode,
      exitPublicMode,
    }),
    [status, session, login, logout, setupCredentials, enterPublicMode, exitPublicMode]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth() must be called inside an <AuthProvider>.");
  return ctx;
}
