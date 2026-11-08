/**
 * Ejecutor de migraciones versionadas de Farmacia Vitalis.
 *
 * Uso:
 *   npx tsx scripts/migrate.ts              # aplica migraciones pendientes
 *   npx tsx scripts/migrate.ts --dry-run    # solo muestra las pendientes
 *
 * Reglas:
 * - Cada archivo de database/migrations/NNNN_nombre.sql se aplica una sola vez.
 * - Cada migración corre dentro de una transacción; si falla, no queda nada aplicado.
 * - Se guarda un checksum SHA-256. Si un archivo ya aplicado cambia, se detiene.
 * - Las migraciones deben ser aditivas. Cualquier cambio destructivo requiere
 *   autorización explícita y respaldo previo (ver docs/BASE_DE_DATOS.md).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";

const ROOT = resolve(__dirname, "..");
const MIGRATIONS_DIR = join(ROOT, "database", "migrations");

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const envPath = join(ROOT, ".env.local");
  if (existsSync(envPath)) {
    const match = readFileSync(envPath, "utf8").match(/^DATABASE_URL=(.*)$/m);
    if (match) return match[1].trim().replace(/^"|"$/g, "");
  }

  throw new Error("Falta DATABASE_URL (variable de entorno o .env.local).");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const client = new Client({ connectionString: loadDatabaseUrl() });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS farmacia.schema_migrations (
        version varchar(10) PRIMARY KEY,
        name varchar(200) NOT NULL,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const applied = new Map<string, string>();
    const appliedRows = await client.query<{ version: string; checksum: string }>(
      `SELECT version, checksum FROM farmacia.schema_migrations`,
    );
    for (const row of appliedRows.rows) applied.set(row.version, row.checksum.trim());

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort();

    let pending = 0;

    for (const file of files) {
      const version = file.slice(0, 4);
      const name = file.slice(5, -4);
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");

      if (applied.has(version)) {
        if (applied.get(version) !== checksum) {
          throw new Error(
            `La migración ${file} ya fue aplicada pero su contenido cambió. No se continúa.`,
          );
        }
        continue;
      }

      pending++;

      if (dryRun) {
        console.log(`PENDIENTE  ${file}`);
        continue;
      }

      console.log(`APLICANDO  ${file}`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          `INSERT INTO farmacia.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)`,
          [version, name, checksum],
        );
        await client.query("COMMIT");
        console.log(`OK         ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    if (pending === 0) {
      console.log("No hay migraciones pendientes.");
    } else {
      console.log(dryRun ? `Migraciones pendientes: ${pending}` : `Migraciones aplicadas: ${pending}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("ERROR DE MIGRACIÓN:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
