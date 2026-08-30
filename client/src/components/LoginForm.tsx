// Rendered instead of the private dashboard whenever useAuth()'s status is
// "gate-login" — real credentials exist and no session cookie is present.
import { useId, useState, type FormEvent } from "react";
import { ApiError } from "../api/http.ts";
import { useAuth } from "../hooks/useAuth.tsx";
import ShinyText from "./ShinyText.tsx";

export function LoginForm() {
  const { login, enterPublicMode } = useAuth();
  const usernameId = useId();
  const passwordId = useId();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
    } catch (err) {
      // ApiError's message is already the server's `{error}` string (400
      // malformed body, 401 invalid credentials, 429 rate-limited with a
      // "try again in Ns" wait time) — safe to show as-is.
      setError(err instanceof ApiError ? err.message : "Failed to sign in. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    // No background mounted here: the app shell (App.tsx) already mounts
    // the animated Aurora backdrop once, full-viewport, stable across every
    // auth state — this stays fully transparent so that shows through
    // instead of a second, independently-animating instance layering on
    // top of it.
    <div className="relative z-10 flex min-h-screen items-center justify-center px-4 font-sans">
      <div className="glass-strong relative w-full max-w-sm p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="glass mb-4 flex h-12 w-12 items-center justify-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="h-6 w-6 text-accent"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-semibold">
            <ShinyText
              text="Sign in to Lantern"
              color="var(--color-text-primary)"
              shineColor="var(--color-accent)"
              speed={3}
              delay={1.5}
            />
          </h1>
          <p className="mt-2 text-base text-text-secondary">
            This dashboard is protected. The public status page stays open at /status.
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <div className="mb-4">
            <label htmlFor={usernameId} className="mb-1.5 block text-sm font-medium text-text-secondary">
              Username
            </label>
            <input
              id={usernameId}
              name="username"
              type="text"
              autoComplete="username"
              autoFocus
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-md text-text-primary outline-none transition-colors duration-[var(--duration-fast)] ease-out placeholder:text-text-muted focus:border-border-focus disabled:opacity-50"
            />
          </div>

          <div className="mb-5">
            <label htmlFor={passwordId} className="mb-1.5 block text-sm font-medium text-text-secondary">
              Password
            </label>
            <div className="relative">
              <input
                id={passwordId}
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={submitting}
                className="w-full rounded-md border border-border bg-bg px-3 py-2 pr-10 text-md text-text-primary outline-none transition-colors duration-[var(--duration-fast)] ease-out placeholder:text-text-muted focus:border-border-focus disabled:opacity-50"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                disabled={submitting}
                aria-label={showPassword ? "Hide password" : "Show password"}
                aria-pressed={showPassword}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-text-muted transition-colors duration-[var(--duration-fast)] ease-out hover:text-text-primary disabled:opacity-50"
              >
                {showPassword ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="h-4.5 w-4.5"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88"
                    />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={1.5}
                    stroke="currentColor"
                    className="h-4.5 w-4.5"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z"
                    />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="mb-4 rounded-md border border-down/30 bg-down-bg px-3 py-2 text-sm text-down"
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || username === "" || password === ""}
            className="w-full rounded-md bg-accent px-4 py-2 text-md font-medium text-white transition-transform duration-[var(--duration-fast)] ease-out active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <button
          type="button"
          onClick={enterPublicMode}
          className="mt-5 w-full text-center text-sm text-text-secondary underline decoration-transparent underline-offset-2 transition-colors duration-[var(--duration-fast)] ease-out hover:text-text-primary hover:decoration-current"
        >
          View public status page
        </button>
      </div>
    </div>
  );
}
