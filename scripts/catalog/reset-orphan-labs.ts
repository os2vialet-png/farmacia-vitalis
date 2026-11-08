/**
 * Limpieza segura de laboratorios huérfanos creados por un lote fallido de importación de marcas.
 * Solo elimina laboratorios que NINGÚN producto referencia (manufacturer_id ni registration_holder_id).
 *
 *   npx tsx scripts/catalog/reset-orphan-labs.ts
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";

const ROOT = resolve(__dirname, "..", "..");

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const match = readFileSync(join(ROOT, ".env.local"), "utf8").match(/^DATABASE_URL=(.*)$/m);
  const value = match?.[1] ?? "";
  if (value.trim() === "") throw new Error("Falta DATABASE_URL.");
  return value.trim().replace(/^"|"$/g, "");
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: loadDatabaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    // Referenciados por productos: hay que conservarlos.
    const refs = await client.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM farmacia.catalog_products WHERE manufacturer_id IS NOT NULL OR registration_holder_id IS NOT NULL`,
    );
    if (refs.rows[0].n > 0) {
      throw new Error(`Hay ${refs.rows[0].n} productos con laboratorio asignado: no se elimina nada.`);
    }
    const deleted = await client.query<{ n: number }>(
      `WITH removed AS (DELETE FROM farmacia.laboratories WHERE true RETURNING 1) SELECT COUNT(*)::int AS n FROM removed`,
    );
    await client.query("COMMIT");
    console.log(`Laboratorios huérfanos eliminados: ${deleted.rows[0].n}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
