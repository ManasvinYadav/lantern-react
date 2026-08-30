// Sets up real admin credentials via PUT /api/auth/credentials, for the
// "can_setup" case: auth_required is false (nothing is locked yet) but no
// username/password pair exists. Meant to be embedded in a dismissible
// banner or a Settings-drawer callout by a later integration pass — not
// mounted here, so it takes onSuccess/onCancel rather than owning its own
// visibility.
import { useId, useState, type FormEvent } from "react";
import { ApiError } from "../api/http.ts";
import { useAuth } from "../hooks/useAuth.tsx";
import Aurora from "./Aurora.tsx";
import ShinyText from "./ShinyText.tsx";

const MIN_PASSWORD_LENGTH = 8;

export interface CredentialsSetupFormProps {
  /** Called after the credentials are saved and the new session is live. */
  onSuccess?: () => void;
  /** Called when the user backs out without submitting (e.g. dismiss the
   * banner it's embedded in). Omit to render without a cancel affordance. */
  onCancel?: () => void;
}

export function CredentialsSetupForm({ onSuccess, onCancel }: CredentialsSetupFormProps) {
  const { tokenMode, setupCredentials } = useAuth();
  const usernameId = useId();
  const passwordId = useId();
  const confirmId = useId();
  const tokenId = useId();

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [adminToken, setAdminToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setSubmitting(true);
    try {
      await setupCredentials({
        new_username: newUsername.trim(),
        new_password: newPassword,
        admin_token: tokenMode ? adminToken : undefined,
      });
      onSuccess?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to set up credentials. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 font-sans">
      {/* Full-viewport animated liquid-glass backdrop, fixed behind the modal —
          same background layer as LoginForm for visual consistency. */}
      <div className="pointer-events-none fixed inset-0 -z-10" aria-hidden="true">
        <Aurora colorStops={["#10b981", "#3884ff", "#8b5cf6"]} amplitude={1.2} blend={0.55} speed={0.6} />
      </div>

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
              text="Set up admin credentials"
              color="var(--color-text-primary)"
              shineColor="var(--color-accent)"
              speed={3}
              delay={1.5}
            />
          </h1>
          <p className="mt-2 text-base text-text-secondary">
            No password is required yet — anyone with network access to this instance can use it. Set a username and
            password to lock it down.
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          {tokenMode && (
            <div className="mb-4">
              <label htmlFor={tokenId} className="mb-1.5 block text-sm font-medium text-text-secondary">
                Admin API token
              </label>
              <input
                id={tokenId}
                name="admin_token"
                type="password"
                autoComplete="off"
                required
                value={adminToken}
                onChange={(e) => setAdminToken(e.target.value)}
                disabled={submitting}
                className="w-full rounded-md border border-border bg-bg px-3 py-2 text-md text-text-primary outline-none transition-colors duration-[var(--duration-fast)] ease-out placeholder:text-text-muted focus:border-border-focus disabled:opacity-50"
              />
              <p className="mt-1 text-xs text-text-muted">
                An admin token is already configured on this server — prove it to enable password setup.
              </p>
            </div>
          )}

          <div className="mb-4">
            <label htmlFor={usernameId} className="mb-1.5 block text-sm font-medium text-text-secondary">
              Username
            </label>
            <input
              id={usernameId}
              name="new_username"
              type="text"
              autoComplete="username"
              required
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              disabled={submitting}
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-md text-text-primary outline-none transition-colors duration-[var(--duration-fast)] ease-out placeholder:text-text-muted focus:border-border-focus disabled:opacity-50"
            />
          </div>

          <div className="mb-4">
            <label htmlFor={passwordId} className="mb-1.5 block text-sm font-medium text-text-secondary">
              Password
            </label>
            <input
              id={passwordId}
              name="new_password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              disabled={submitting}
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-md text-text-primary outline-none transition-colors duration-[var(--duration-fast)] ease-out placeholder:text-text-muted focus:border-border-focus disabled:opacity-50"
            />
          </div>

          <div className="mb-5">
            <label htmlFor={confirmId} className="mb-1.5 block text-sm font-medium text-text-secondary">
              Confirm password
            </label>
            <input
              id={confirmId}
              name="confirm_password"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={submitting}
              className="w-full rounded-md border border-border bg-bg px-3 py-2 text-md text-text-primary outline-none transition-colors duration-[var(--duration-fast)] ease-out placeholder:text-text-muted focus:border-border-focus disabled:opacity-50"
            />
          </div>

          {error && (
            <div role="alert" className="mb-4 rounded-md border border-down/30 bg-down-bg px-3 py-2 text-sm text-down">
              {error}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="submit"
              disabled={submitting || newUsername === "" || newPassword === "" || confirmPassword === ""}
              className="flex-1 rounded-md bg-accent px-4 py-2 text-md font-medium text-white transition-transform duration-[var(--duration-fast)] ease-out active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Saving…" : "Set credentials"}
            </button>
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                disabled={submitting}
                className="glass flex-1 px-4 py-2 text-md font-medium text-text-secondary transition-colors duration-[var(--duration-fast)] ease-out hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                Not now
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
