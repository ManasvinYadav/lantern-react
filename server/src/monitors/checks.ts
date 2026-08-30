import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import type { TLSSocket } from "node:tls";
import { MAX_HTTP_REDIRECTS, MONITOR_CHECK_TIMEOUT_MS } from "./constants.js";

export interface CheckResult {
  status: string;
  message: string;
  certExpiry: Date | null;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(3)}s`;
}

function requestOnce(
  target: string,
  deadlineAt: number
): Promise<{ statusCode: number; location: string | null; certExpiry: Date | null }> {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const client = url.protocol === "https:" ? https : http;
    const remainingMs = Math.max(1, deadlineAt - Date.now());

    const req = client.get(target, { timeout: remainingMs }, (res) => {
      let certExpiry: Date | null = null;
      const socket = res.socket as TLSSocket;
      if (url.protocol === "https:" && typeof socket.getPeerCertificate === "function") {
        const cert = socket.getPeerCertificate();
        if (cert && cert.valid_to) {
          const parsed = new Date(cert.valid_to);
          if (!Number.isNaN(parsed.getTime())) certExpiry = parsed;
        }
      }
      // Drain the body; monitors don't need it, but the socket must be
      // consumed or the connection can't be reused/closed cleanly.
      res.resume();
      resolve({
        statusCode: res.statusCode ?? 0,
        location: (res.headers.location as string | undefined) ?? null,
        certExpiry,
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error(`request timed out after ${formatDuration(remainingMs)}`));
    });
    req.on("error", (err) => reject(err));
  });
}

// Ported from monitors.go checkHTTP (~L195-215). Up = any status code < 400
// (redirects the client follows itself never reach this comparison as a
// 3xx — only exceeding the redirect cap does, and that surfaces as a
// transport error, "down"). Uses the platform's default TLS verification
// (Node's bundled CA store), matching Go's use of the default
// http.Transport with no InsecureSkipVerify — an invalid cert fails the
// request itself rather than reaching cert-expiry extraction.
export async function checkHttp(target: string): Promise<CheckResult> {
  const start = Date.now();
  const deadlineAt = start + MONITOR_CHECK_TIMEOUT_MS;
  let currentTarget = target;
  let lastCertExpiry: Date | null = null;

  try {
    for (let redirectCount = 0; redirectCount <= MAX_HTTP_REDIRECTS; redirectCount++) {
      if (redirectCount === MAX_HTTP_REDIRECTS) {
        return { status: "down", message: `stopped after ${MAX_HTTP_REDIRECTS} redirects`, certExpiry: null };
      }

      const result = await requestOnce(currentTarget, deadlineAt);
      if (result.certExpiry) lastCertExpiry = result.certExpiry;

      const isRedirect = result.statusCode >= 300 && result.statusCode < 400 && result.location;
      if (isRedirect) {
        currentTarget = new URL(result.location as string, currentTarget).toString();
        continue;
      }

      const rtt = Date.now() - start;
      if (result.statusCode < 400) {
        return {
          status: "up",
          message: `HTTP ${result.statusCode} in ${formatDuration(rtt)}`,
          certExpiry: lastCertExpiry,
        };
      }
      return { status: "down", message: `HTTP ${result.statusCode}`, certExpiry: lastCertExpiry };
    }
    // Unreachable, but keeps TypeScript's control-flow analysis satisfied.
    return { status: "down", message: "unreachable", certExpiry: null };
  } catch (err) {
    return { status: "down", message: err instanceof Error ? err.message : String(err), certExpiry: null };
  }
}

// Ported from monitors.go checkTCP (~L216-227). Up = bare TCP connect
// success — no data sent or read, connection opened then immediately closed.
export function checkTcp(target: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const [host, portStr] = splitHostPort(target);
    if (host === null) {
      resolve({ status: "down", message: "tcp target must be host:port", certExpiry: null });
      return;
    }
    const start = Date.now();
    const socket = net.createConnection({ host, port: Number(portStr), timeout: MONITOR_CHECK_TIMEOUT_MS });

    socket.once("connect", () => {
      const rtt = Date.now() - start;
      socket.destroy();
      resolve({ status: "up", message: `TCP connect succeeded in ${formatDuration(rtt)}`, certExpiry: null });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ status: "down", message: "connection timed out", certExpiry: null });
    });
    socket.once("error", (err) => {
      socket.destroy();
      resolve({ status: "down", message: err.message, certExpiry: null });
    });
  });
}

function splitHostPort(target: string): [string | null, string] {
  const idx = target.lastIndexOf(":");
  if (idx <= 0 || idx === target.length - 1) return [null, ""];
  return [target.slice(0, idx), target.slice(idx + 1)];
}

// Ported from monitors.go checkPing (~L229-303), adapted per the directive
// to child_process.spawn('ping') rather than a raw ICMP socket. See
// docs/phase2-notes: this trades Go's CAP_NET_RAW-on-the-process
// requirement for a requirement on the `ping` binary's own capability bit
// (present by default on Debian/Ubuntu/Alpine base images), which is a
// looser constraint on the Node process itself. IPv4/IPv6 is whatever the
// system `ping` resolves to, unlike Go's hardcoded IPv4-only socket.
export function checkPing(target: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const timeoutSeconds = Math.ceil(MONITOR_CHECK_TIMEOUT_MS / 1000);
    const args =
      process.platform === "darwin"
        ? ["-c", "1", "-t", String(timeoutSeconds), target]
        : ["-c", "1", "-W", String(timeoutSeconds), target];

    const start = Date.now();
    const child = spawn("ping", args);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.once("error", (err) => {
      resolve({ status: "down", message: `ping exec error: ${err.message}`, certExpiry: null });
    });

    child.once("close", (code) => {
      const rtt = Date.now() - start;
      if (code === 0) {
        resolve({ status: "up", message: `ping succeeded in ${formatDuration(rtt)}`, certExpiry: null });
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `ping exited with code ${code}`;
      resolve({ status: "down", message: detail, certExpiry: null });
    });
  });
}
