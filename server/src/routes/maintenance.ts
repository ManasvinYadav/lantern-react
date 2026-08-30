import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";

interface PutMaintenanceBody {
  enabled?: boolean;
  note?: string;
}

// Ported from extensions.go setMaintenanceState (~L641-661): the single
// write path for toggling a service's maintenance flag, shared by
// PUT /api/services/{name}/maintenance and the optional `maintenance` field
// on POST /api/status, so both stay in sync on service_maintenance and the
// maintenance_windows audit trail instead of the two diverging. `now` uses
// toISOString() (not Go's fractionless RFC3339) to match the
// millisecond-precision timestamps the rest of this codebase already
// writes — see metrics/compute.ts's note on fetchEvents.
export function setMaintenanceState(
  db: Database.Database,
  name: string,
  enabled: boolean,
  note: string
): string {
  const now = new Date().toISOString();
  const val = enabled ? 1 : 0;

  db.prepare(
    `INSERT INTO service_maintenance (service_name, enabled, note, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(service_name) DO UPDATE SET enabled = ?, note = ?, updated_at = ?`
  ).run(name, val, note, now, val, note, now);

  if (enabled) {
    db.prepare(
      "INSERT INTO maintenance_windows (service_name, started_at, note) VALUES (?, ?, ?)"
    ).run(name, now, note);
  } else {
    db.prepare(
      "UPDATE maintenance_windows SET ended_at = ? WHERE service_name = ? AND ended_at IS NULL"
    ).run(now, name);
  }

  return now;
}

// Ported from extensions.go handlePutMaintenance/handleGetMaintenance
// (~L663-705).
export async function registerMaintenanceRoutes(app: FastifyInstance, db: Database.Database) {
  app.put<{ Params: { name: string }; Body: PutMaintenanceBody }>(
    "/api/services/:name/maintenance",
    async (request, reply) => {
      const body = request.body;
      // Go's json.Decode fails (and 400s) on a missing/unparsable body;
      // Fastify's own JSON content-type parser already rejects malformed
      // JSON syntax before this handler runs, so this covers the
      // no-body-sent case Fastify lets through as `undefined`.
      if (!body || typeof body !== "object") {
        reply.code(400).send({ error: "invalid json" });
        return;
      }

      const { name } = request.params;
      const enabled = body.enabled ?? false;
      const note = body.note ?? "";

      const now = setMaintenanceState(db, name, enabled, note);

      reply.send({
        service_name: name,
        enabled,
        note,
        updated_at: now,
      });
    }
  );

  app.get<{ Params: { name: string } }>(
    "/api/services/:name/maintenance",
    async (request, reply) => {
      const { name } = request.params;

      const row = db
        .prepare("SELECT enabled, note, updated_at FROM service_maintenance WHERE service_name = ?")
        .get(name) as { enabled: number; note: string | null; updated_at: string | null } | undefined;

      // Ported from extensions.go handleGetMaintenance: no row (unknown or
      // never-toggled service) is not an error — it just yields the zero
      // value response {enabled:false, note:"", updated_at:""}, same as Go's
      // unpopulated struct after a failed Scan.
      reply.send({
        service_name: name,
        enabled: row ? row.enabled === 1 : false,
        note: row?.note ?? "",
        updated_at: row?.updated_at ?? "",
      });
    }
  );
}
