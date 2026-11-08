/**
 * Muestra los intentos fallidos de login recientes por usuario e IP (sin datos sensibles).
 *   npx tsx --env-file=.env.local scripts/qa/diag-limiter.ts --logins
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";

const ROOT = resolve(__dirname, "..");

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const match = readFileSync(join(ROOT, ".env.local"), "utf8").match(/^DATABASE_URL=(.*)$/m);
  if (!match) throw new Error("Falta DATABASE_URL.");
  return match[1].trim().replace(/^"|"$/g, "");
}

async function main() {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    const rows = await client.query(
      `SELECT new_values->>'username' AS username, ip_address,
              to_char(created_at, 'HH24:MI') AS at
       FROM farmacia.audit_logs
       WHERE action = 'login_failed'
         AND created_at > NOW() - make_interval(mins => 15)
       ORDER BY created_at DESC
       LIMIT 60`,
    );
    for (const row of rows.rows) {
      console.log(`${row.at}  usuario=${row.username}  ip=${row.ip_address ?? "null"}`);
    }
    const summary = await client.query<{ username: string; ip: string | null; n: number }>(
      `SELECT new_values->>'username' AS username, COALESCE(ip_address::text, 'null') AS ip, COUNT(*)::int AS n
       FROM farmacia.audit_logs
       WHERE action = 'login_failed' AND created_at > NOW() - make_interval(mins => 15)
       GROUP BY 1, 2 ORDER BY n DESC`,
    );
    console.log("--- resumen por usuario+ip ---");
    for (const row of summary.rows) console.log(`${row.username} @ ${row.ip}: ${row.n}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
