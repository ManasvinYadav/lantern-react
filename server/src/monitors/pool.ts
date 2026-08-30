import type Database from "better-sqlite3";
import type { Config } from "../config.js";
import { ingestStatusEvent, type IngestHooks } from "../status/ingest.js";
import { certStatusFor } from "./certStatus.js";
import { checkHttp, checkPing, checkTcp } from "./checks.js";
import { MONITOR_QUEUE_SIZE, MONITOR_WORKER_COUNT } from "./constants.js";

export interface MonitorCheckJob {
  serviceName: string;
  monitorType: string;
  target: string;
}

// Ported from monitors.go monitorPool (~L100-190): a fixed-size worker pool
// draining one shared job queue, so up to MONITOR_WORKER_COUNT checks run
// concurrently regardless of type mix. Queue overflow drops the job with a
// log line rather than blocking the enqueuing caller.
export class MonitorPool {
  private readonly queue: MonitorCheckJob[] = [];
  private activeWorkers = 0;

  constructor(
    private readonly db: Database.Database,
    private readonly cfg: Config,
    private readonly hooks: IngestHooks
  ) {}

  enqueue(job: MonitorCheckJob): void {
    if (this.queue.length >= MONITOR_QUEUE_SIZE) {
      console.log(
        `monitor check queue full, dropping check: service=${job.serviceName} type=${job.monitorType}`
      );
      return;
    }
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    while (this.activeWorkers < MONITOR_WORKER_COUNT && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) break;
      this.activeWorkers += 1;
      void this.runJob(job).finally(() => {
        this.activeWorkers -= 1;
        this.pump();
      });
    }
  }

  private async runCheck(job: MonitorCheckJob): Promise<{
    status: string;
    message: string;
    certExpiry: Date | null;
  }> {
    switch (job.monitorType) {
      case "http":
        return checkHttp(job.target);
      case "tcp":
        return checkTcp(job.target);
      case "ping":
        return checkPing(job.target);
      default:
        return { status: "unknown", message: `unrecognized monitor type: ${job.monitorType}`, certExpiry: null };
    }
  }

  private async runJob(job: MonitorCheckJob): Promise<void> {
    // Measured around runCheck only, so the recorded latency is the
    // network check and excludes the DB writes below.
    const start = Date.now();
    const { status: rawStatus, message: rawMessage, certExpiry } = await this.runCheck(job);
    const latencyMs = Date.now() - start;

    let status = rawStatus;
    let message = rawMessage;

    if (certExpiry) {
      const hoursLeft = (certExpiry.getTime() - Date.now()) / (1000 * 60 * 60);
      const daysLeft = Math.trunc(hoursLeft / 24);
      const on = certExpiry.toISOString().slice(0, 10);

      const certStatus = certStatusFor(daysLeft, this.cfg.certWarnDays, this.cfg.certCriticalDays);
      switch (certStatus) {
        case "expired":
          status = "down";
          message = `${message} — TLS certificate EXPIRED ${-daysLeft} day(s) ago (${on})`;
          break;
        case "critical":
          if (status === "up") status = "degraded";
          message = `${message} — TLS certificate expires in ${daysLeft} day(s) (${on})`;
          break;
        case "warning":
          message = `${message} — TLS certificate expires in ${daysLeft} day(s) (${on})`;
          break;
      }
    }

    ingestStatusEvent(this.db, job.serviceName, status, message, new Date(), latencyMs, this.hooks);

    const nowIso = new Date().toISOString();
    if (certExpiry) {
      this.db
        .prepare("UPDATE active_monitors SET last_checked_at = ?, cert_expiry_at = ? WHERE service_name = ?")
        .run(nowIso, certExpiry.toISOString(), job.serviceName);
    } else {
      this.db
        .prepare("UPDATE active_monitors SET last_checked_at = ? WHERE service_name = ?")
        .run(nowIso, job.serviceName);
    }
  }
}
