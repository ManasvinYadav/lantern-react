import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";
import {
  authRequired,
  loadCredentials,
  verifyCredentials,
  writeCredentials,
  refreshCredentialState,
} from "./credentials.js";
import {
  clearSessionCookie,
  createSession,
  revokeAllSessions,
  revokeSession,
  sessionUser,
  setSessionCookie,
} from "./sessions.js";
import { isBlocked, recordFailure, recordSuccess, throttleKey } from "./throttle.js";

interface LoginBody {
  username?: string;
  password?: string;
}

interface CredentialsBody {
  current_password?: string;
  new_username?: string;
  new_password?: string;
}

// Ported verbatim from auth.go handleGetAuthSession/handlePostLogin/
// handlePostLogout/handlePutCredentials (~L525-699).
export async function registerAuthRoutes(app: FastifyInstance, db: Database.Database, cfg: Config) {
  app.get("/api/auth/session", async (request, reply) => {
    const cookieToken = request.cookies?.lantern_session;
    let authenticated = false;
    let username: string | undefined;
    if (cookieToken) {
      const user = sessionUser(db, cookieToken);
      if (user) {
        authenticated = true;
        username = user;
      }
    }
    reply.send({
      auth_required: authRequired(),
      authenticated,
      username,
      token_mode: !authRequired() && cfg.authToken !== "",
      can_setup: !authRequired(),
    });
  });

  app.post<{ Body: LoginBody }>("/api/auth/login", async (request, reply) => {
    const key = throttleKey(request);
    const { blocked, waitMs } = isBlocked(key);
    if (blocked) {
      const waitSeconds = Math.floor(waitMs / 1000) + 1;
      reply.header("Retry-After", String(waitSeconds));
      reply.code(429).send({ error: `Too many failed attempts. Try again in ${waitSeconds}s.` });
      return;
    }
    if (!authRequired()) {
      reply.code(400).send({ error: "No credentials are configured on this server." });
      return;
    }

    const { username, password } = request.body ?? {};
    if (!username || !password) {
      reply.code(400).send({ error: "Malformed request body." });
      return;
    }

    if (!(await verifyCredentials(db, username, password))) {
      recordFailure(key);
      reply.code(401).send({ error: "Invalid credentials" });
      return;
    }

    const { raw, expiresAtMs } = createSession(db, username);
    recordSuccess(key);
    setSessionCookie(request, reply, raw, expiresAtMs);
    reply.send({ authenticated: true, username });
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const cookieToken = request.cookies?.lantern_session;
    if (cookieToken) {
      revokeSession(db, cookieToken);
    }
    clearSessionCookie(request, reply);
    reply.send({ authenticated: false });
  });

  app.put<{ Body: CredentialsBody }>("/api/auth/credentials", async (request, reply) => {
    const body = request.body ?? {};
    const setup = !authRequired();

    // Second lock: on a token-mode deployment, setup must prove the admin
    // token rather than minting an admin session out of nothing.
    if (setup && cfg.authToken !== "") {
      if (!request.authContext?.isAdmin) {
        reply.code(401).send({
          error: "Set credentials with the admin API token, or unset LANTERN_AUTH_TOKEN first.",
        });
        return;
      }
    }

    const current = loadCredentials(db);
    const currentUser = current?.username ?? "";

    if (!setup) {
      if (!body.current_password) {
        reply.code(400).send({ error: "Current password is required." });
        return;
      }
      if (!(await verifyCredentials(db, currentUser, body.current_password))) {
        reply.code(401).send({ error: "Current password is incorrect" });
        return;
      }
    }

    const newUser = (body.new_username ?? "").trim() || currentUser;
    const newPass = body.new_password ?? "";

    if (setup) {
      if (!newUser) {
        reply.code(400).send({ error: "A username is required." });
        return;
      }
      if (!newPass) {
        reply.code(400).send({ error: "A password is required." });
        return;
      }
    }

    if (!newPass) {
      db.prepare("UPDATE admin_credentials SET username = ?, updated_at = ? WHERE id = 1").run(
        newUser,
        Math.floor(Date.now() / 1000)
      );
    } else {
      if (newPass.length < 8) {
        reply.code(400).send({ error: "New password must be at least 8 characters." });
        return;
      }
      await writeCredentials(db, newUser, newPass);
    }

    // Rotate: every existing session dies, then the caller is handed a
    // fresh one so the tab they're using stays logged in.
    revokeAllSessions(db);
    refreshCredentialState(db);

    const { raw, expiresAtMs } = createSession(db, newUser);
    setSessionCookie(request, reply, raw, expiresAtMs);
    reply.send({ updated: true, username: newUser, reauth: false });
  });
}
