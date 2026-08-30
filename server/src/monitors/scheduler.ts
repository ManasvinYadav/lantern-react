import type Database from "better-sqlite3";
import type { MonitorPool } from "./pool.js";

// Ported from monitors.go monitorScheduler (~L308-384). One ticker per
// enabled monitor row, keyed by service name. The stop-and-replace on
// restart must happen as one atomic step: a prior bug split it into
// "stop, then store the new one" as two steps, letting two concurrent
// updates for the same service each create a timer and overwrite each
// other's entry in the map — the overwritten timer's stop handle became
// unreachable and ran forever, even after the service was deleted. Node's
// single-threaded event loop makes the two-step version safe by accident
// (no true concurrent map mutation), but doing it atomically here anyway
// documents the invariant and survives a future move to worker threads.
export class MonitorScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: Database.Database,
    private readonly pool: MonitorPool
  ) {}

  start(serviceName: string, monitorType: string, target: string, intervalSeconds: number): void {
    const prev = this.timers.get(serviceName);
    if (prev) clearInterval(prev);

    // Run an immediate check on (re)start so status appears right away
    // instead of waiting a full interval.
    this.pool.enqueue({ serviceName, monitorType, target });

    const timer = setInterval(() => {
      this.pool.enqueue({ serviceName, monitorType, target });
    }, intervalSeconds * 1000);
    this.timers.set(serviceName, timer);
  }

  stop(serviceName: string): void {
    const timer = this.timers.get(serviceName);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(serviceName);
    }
  }

  // Starts a ticker for every enabled monitor found in the DB. Called once
  // at startup.
  loadAndStartAll(): void {
    const rows = this.db
      .prepare(
        "SELECT service_name, monitor_type, target, interval_seconds FROM active_monitors WHERE enabled = 1"
      )
      .all() as { service_name: string; monitor_type: string; target: string; interval_seconds: number }[];

    for (const row of rows) {
      this.start(row.service_name, row.monitor_type, row.target, row.interval_seconds);
    }
    console.log(`monitorScheduler: started ${rows.length} active monitor(s)`);
  }
}
