import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

interface GroupSummary {
  name: string;
  count: number;
}

// Ported from main.go handleGetGroups (~L1761-1797). Also served at
// /api/public/groups by the same handler (setupRoutes' publicApi
// subrouter, main.go:1898).
export async function registerGroupsRoutes(app: FastifyInstance, db: Database.Database) {
  const getGroups = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const rows = db
        .prepare(
          `SELECT COALESCE(g.group_name, '') AS name, COUNT(DISTINCT s.service_name) AS count
           FROM status_events s
           LEFT JOIN service_groups g ON s.service_name = g.service_name
           WHERE s.id IN (SELECT MAX(id) FROM status_events GROUP BY service_name)
           GROUP BY COALESCE(g.group_name, '')
           ORDER BY COALESCE(g.group_name, '') ASC`
        )
        .all() as GroupSummary[];

      const groups = rows.filter((g) => g.name !== "");
      reply.send(groups);
    } catch (err) {
      app.log.error(err, "handleGetGroups db error");
      reply.code(500).send({ error: "database error" });
    }
  };

  app.get("/api/groups", getGroups);
  app.get("/api/public/groups", getGroups);
}
