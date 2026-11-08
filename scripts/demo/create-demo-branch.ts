/**
 * Crea (o reactiva) una segunda sucursal de demostración con datos ficticios.
 *   npx tsx scripts/demo/create-demo-branch.ts
 * La dirección y el teléfono son ficticios (prefijo 555). Para retirarla, desactívala:
 *   UPDATE farmacia.branches SET is_active = FALSE WHERE code = 'VITALIS-002';
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";

const ROOT = resolve(__dirname, "..", "..");

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
    await client.query("BEGIN");
    const branch = await client.query<{ id: string }>(
      `INSERT INTO farmacia.branches (code, name, address, phone, is_active)
       VALUES ('VITALIS-002', 'Farmacia Vitalis - Santiago (demo)',
               'Av. 27 de Febrero 145, Los Jardines, Santiago (dirección ficticia)', '809-555-0142', TRUE)
       ON CONFLICT (code) DO UPDATE SET is_active = TRUE
       RETURNING id`,
    );
    await client.query(
      `INSERT INTO farmacia.audit_logs (actor_user_id, branch_id, action, entity, entity_id, new_values)
       VALUES (NULL, $1, 'branch.create_demo', 'branch', $1, '{"demo": true}'::jsonb)`,
      [branch.rows[0].id],
    );
    await client.query("COMMIT");
    console.log("Sucursal de demostración lista: Farmacia Vitalis - Santiago (demo), código VITALIS-002.");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
