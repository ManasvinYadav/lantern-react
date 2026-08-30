// Account & Security settings tab — view the current admin username and
// change credentials (username and/or password) on an already-set-up
// account.
//
// This is deliberately NOT CredentialsSetupForm reused: that component is
// first-run-only (its onSuccess/onCancel + full-viewport layout are built
// for the "no credentials exist yet" gate, and its call into
// useAuth().setupCredentials() never sends `current_password`). The server
// route this hits — PUT /api/auth/credentials in
// server/src/auth/routes.ts — is the *same endpoint* for both first-run
// setup and a logged-in change, but branches on `!authRequired()`
// ("setup"): setup skips the current-password check entirely, while a real
// change (this component's case, since reaching this tab means credentials
// already exist and the user is authenticated) requires and verifies
// `current_password` before anything is written. useAuth()'s
// `setupCredentials` wrapper only forwards `new_username`/`new_password`
// (+ an admin-token header for the token-mode *setup* case) — it has no
// field for `current_password` — so this component calls
// `api/auth.ts`'s `setupCredentials()` directly instead, passing
// `current_password` through the `SetupCredentialsRequest` shape it already
// supports. No admin-token header is ever needed here: that header only
// matters on the setup path (routes.ts's `if (setup && cfg.authToken !== "")`
// guard), which this flow never takes.
//
// Self-contained: no required props, does its own useAuth() read and its
// own submit. Exported both ways (default + named) since the shell
// integrating this tab may import either.
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../../api/http.ts";
import { setupCredentials as changeCredentials } from "../../api/auth.ts";
import { useAuth } from "../../hooks/useAuth.tsx";

const MIN_PASSWORD_LENGTH = 8;

type IconProps = { className?: string };

function IconEye({ className = "h-4.5 w-4.5" }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
    </svg>
  );
}

function IconEyeOff({ className = "h-4.5 w-4.5" }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.5}
      stroke="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88"
      />
    </svg>
  );
}

// Mirrors ServiceDetailDrawer's / SettingsDrawer's local SectionHeading
// exactly (not imported from either: it's a private, unexported helper in
// both files — duplicating a five-line component is cheaper than coupling
// three otherwise-independent files together).
function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{children}</h3>;
}

const inputClass =
  "w-full rounded-md border border-border bg-bg px-3 py-2 text-sm text-text-primary outline-none transition-colors duration-[var(--duration-fast)] ease-out placeholder:text-text-muted focus:border-border-focus disabled:opacity-50";

const primaryBtnClass =
  "w-full rounded-md bg-accent px-4 py-2 text-sm font-medium text-white transition-transform duration-[var(--duration-fast)] ease-out active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-50";

function PasswordField({
  id,
  name,
  label,
  autoComplete,
  value,
  onChange,
  disabled,
  minLength,
}: {
  id: string;
  name: string;
  label: string;
  autoComplete: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  minLength?: number;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-text-secondary">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          name={name}
          type={show ? "text" : "password"}
          autoComplete={autoComplete}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          minLength={minLength}
          className={`${inputClass} pr-10`}
        />
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          disabled={disabled}
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-text-muted transition-colors duration-[var(--duration-fast)] ease-out hover:text-text-primary disabled:opacity-50"
        >
          {show ? <IconEyeOff /> : <IconEye />}
        </button>
      </div>
    </div>
  );
}

function errMessage(err: unknown, fallback = "Something went wrong."): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

export function AccountSecurityTab() {
  const { status, username } = useAuth();

  const currentPasswordId = useId();
  const newUsernameId = useId();
  const newPasswordId = useId();
  const confirmPasswordId = useId();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newUsername, setNewUsername] = useState(username ?? "");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set on a successful save; also used to display the (possibly new)
  // username immediately without waiting on useAuth()'s `username`, which
  // this component intentionally never mutates (see file-header comment —
  // useAuth.tsx is stable/unmodified, and its setupCredentials() wrapper has
  // no current_password field to reuse here).
  const [savedUsername, setSavedUsername] = useState<string | null>(null);

  // Reaching this tab implies the drawer/shell only mounts it once a real
  // session exists, but guard anyway: this is genuinely the change-flow,
  // not first-run setup, so it has nothing useful to do without an existing
  // authenticated username to change *from*.
  if (status !== "authenticated" || !username) {
    return (
      <div className="glass-subtle px-3 py-3 text-sm text-text-secondary">
        No admin account is signed in yet, so there are no credentials to change here.
      </div>
    );
  }

  const displayUsername = savedUsername ?? username;
  const usernameChanged = savedUsername !== null && savedUsername !== username;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    if (currentPassword === "") {
      setError("Current password is required.");
      return;
    }
    const trimmedUsername = newUsername.trim();
    if (trimmedUsername === "") {
      setError("Username cannot be empty.");
      return;
    }
    if (newPassword !== "") {
      if (newPassword.length < MIN_PASSWORD_LENGTH) {
        setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
        return;
      }
      if (newPassword !== confirmPassword) {
        setError("New passwords do not match.");
        return;
      }
    }
    if (trimmedUsername === displayUsername && newPassword === "") {
      setError("Change the username or set a new password before saving.");
      return;
    }

    setSubmitting(true);
    try {
      const result = await changeCredentials({
        current_password: currentPassword,
        new_username: trimmedUsername,
        new_password: newPassword || undefined,
      });
      setSavedUsername(result.username);
      setNewUsername(result.username);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err) {
      setError(errMessage(err, "Failed to update credentials. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <SectionHeading>Signed in as</SectionHeading>
        <div className="glass-subtle flex items-center px-3 py-2.5">
          <span className="font-mono text-sm text-text-primary">{displayUsername}</span>
        </div>
      </section>

      <section>
        <SectionHeading>Change username or password</SectionHeading>
        <p className="mb-4 text-xs text-text-muted">
          Requires your current password. Saving rotates every other active session for this account — this tab
          stays signed in.
        </p>

        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <PasswordField
            id={currentPasswordId}
            name="current_password"
            label="Current password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={setCurrentPassword}
            disabled={submitting}
          />

          <div>
            <label htmlFor={newUsernameId} className="mb-1.5 block text-sm font-medium text-text-secondary">
              Username
            </label>
            <input
              id={newUsernameId}
              name="new_username"
              type="text"
              autoComplete="username"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              disabled={submitting}
              className={inputClass}
            />
          </div>

          <PasswordField
            id={newPasswordId}
            name="new_password"
            label="New password (leave blank to keep current password)"
            autoComplete="new-password"
            value={newPassword}
            onChange={(v) => {
              setNewPassword(v);
              // Avoid leaving stale text behind in the (now-disabled)
              // confirm field once the new-password field is cleared back
              // to a username-only change.
              if (v === "") setConfirmPassword("");
            }}
            disabled={submitting}
            minLength={MIN_PASSWORD_LENGTH}
          />

          <PasswordField
            id={confirmPasswordId}
            name="confirm_password"
            label="Confirm new password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            disabled={submitting || newPassword === ""}
            minLength={MIN_PASSWORD_LENGTH}
          />

          {error && (
            <div role="alert" className="rounded-md border border-down/30 bg-down-bg px-3 py-2 text-sm text-down">
              {error}
            </div>
          )}

          {savedUsername !== null && !error && (
            <div role="status" className="rounded-md border border-up/30 bg-up-bg px-3 py-2 text-sm text-up">
              Credentials updated.
              {usernameChanged && " Reload the page to see the new username reflected elsewhere in the app."}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || currentPassword === "" || newUsername.trim() === ""}
            className={primaryBtnClass}
          >
            {submitting ? "Saving…" : "Save changes"}
          </button>
        </form>
      </section>
    </div>
  );
}

export default AccountSecurityTab;
