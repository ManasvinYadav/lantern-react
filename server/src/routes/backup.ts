import { createReadStream, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { Config } from "../config.js";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// Matches Go's time.Now().UTC().Format("20060102-150405").
function formatBackupTimestamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}-` +
    `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`
  );
}

// Ported from main.go handleBackup (~L1224-1258): VACUUM INTO a temp file,
// stream it back, then delete the temp copy. better-sqlite3 can't bind a
// parameter into VACUUM INTO (SQLite doesn't accept one there), so the path
// is built into the SQL string directly — safe here because it is entirely
// our own generated temp filename, never user input; the quote-escape is
// only defensive.
// cfg is accepted (not used by Go's handleBackup, which takes only db) to
// match this task's uniform registerXRoutes(app, db, cfg) signature.
export async function registerBackupRoutes(app: FastifyInstance, db: Database.Database, cfg: Config) {
  app.get("/api/backup", async (_request, reply) => {
    const tmpPath = path.join(os.tmpdir(), `lantern-backup-${process.hrtime.bigint()}.db`);

    try {
      db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    } catch (err) {
      app.log.error(err, "handleBackup VACUUM INTO error");
      reply.code(500).send({ error: "failed to snapshot database" });
      return;
    }

    let size: number;
    try {
      size = statSync(tmpPath).size;
    } catch (err) {
      app.log.error(err, "handleBackup open snapshot error");
      await unlink(tmpPath).catch(() => {});
      reply.code(500).send({ error: "failed to read database snapshot" });
      return;
    }

    const filename = `lantern-backup-${formatBackupTimestamp(new Date())}.db`;
    reply.header("Content-Type", "application/octet-stream");
    reply.header("Content-Disposition", `attachment; filename="${filename}"`);
    reply.header("Content-Length", String(size));

    const stream = createReadStream(tmpPath);
    stream.on("close", () => {
      unlink(tmpPath).catch(() => {});
    });
    stream.on("error", (err) => {
      app.log.error(err, "handleBackup stream error");
    });

    reply.send(stream);
  });
}
