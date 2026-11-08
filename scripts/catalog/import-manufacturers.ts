/**
 * Importa el fabricante (marca) de cada producto desde el registro sanitario oficial ya cargado
 * en la base (farmacia.catalog_product_registrations, fuente MISPAS 2018-2026).
 *
 *   npx tsx scripts/catalog/import-manufacturers.ts           # simulación: no modifica nada
 *   npx tsx scripts/catalog/import-manufacturers.ts --apply   # aplica
 *
 * Reglas:
 * - Solo fabricantes reales del registro: se descartan marcadores "N/D" y similares.
 * - Unifica variantes del mismo laboratorio (S.R.L. / SRL, acentos, puntuación final) para
 *   no fragmentar la marca. El nombre que se guardan es el más frecuente en el registro.
 * - No inventa: si ninguna fila del registro trae fabricante, el producto queda sin marca
 *   y se reporta.
 * - Nunca sobrescribe un fabricante ya asignado.
 *
 * Seguridad: respaldo JSON con la marca elegida por producto en backups/, una sola transacción
 * y un registro de auditoría con el resumen del lote.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";

const ROOT = resolve(__dirname, "..", "..");
const APPLY = process.argv.includes("--apply");

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const match = readFileSync(join(ROOT, ".env.local"), "utf8").match(/^DATABASE_URL=(.*)$/m);
  const value = match?.[1] ?? "";
  if (value.trim() === "") throw new Error("Falta DATABASE_URL.");
  return value.trim().replace(/^"|"$/g, "");
}

/** Marcadores vacíos de la fuente oficial: no son fabricantes. */
const PLACEHOLDERS = new Set(["N/D", "ND", "N. D.", "S/D", "SD", "N/A", "NO DISPONIBLE", "SIN DEFINIR", ""]);

interface RegistryRow {
  manufacturer: string;
  status: string;
  valid: boolean;
  importedAt: string | null;
}

interface ProductInput {
  id: string;
  name: string;
  registration: string | null;
  candidates: RegistryRow[];
}

function canonicalLabKey(raw: string): string {
  // 1. Mayúsculas sin acentos; 2. sin puntos (unifica S.R.L./SRL); 3. sin puntuación final.
  const upper = raw
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/[,.\s]+$/g, "");
  return upper;
}

function isPlaceholder(value: string): boolean {
  return PLACEHOLDERS.has(value.trim().toUpperCase());
}

function pickManufacturer(candidates: RegistryRow[]): string | null {
  // Prioridad: valor real > vigente > más reciente.
  const usable = candidates.filter((row) => !isPlaceholder(row.manufacturer));
  if (usable.length === 0) return null;
  usable.sort((a, b) => {
    if (a.valid !== b.valid) return a.valid ? -1 : 1;
    const timeDiff = (new Date(b.importedAt ?? 0).getTime()) - (new Date(a.importedAt ?? 0).getTime());
    if (timeDiff !== 0) return timeDiff;
    return a.manufacturer.localeCompare(b.manufacturer);
  });
  return usable[0].manufacturer.trim();
}

async function main(): Promise<void> {
  const client = new Client({ connectionString: loadDatabaseUrl() });
  await client.connect();

  try {
    await client.query("BEGIN");

    // 1. Registro oficial: TODAS las filas por producto (el vigente manda, pero si su
    //    fabricante es N/D hay que poder tomar las demás).
    const registry = await client.query<{ product_id: string; manufacturer: string; status: string | null; valid: boolean; imported_at: string }>(
      `SELECT r.product_id,
              btrim(r.manufacturer_name) AS manufacturer,
              r.registration_status AS status,
              (r.registration_status = 'VIGENTE' AND (r.expiration_date IS NULL OR r.expiration_date >= CURRENT_DATE))::boolean AS valid,
              r.imported_at
       FROM farmacia.catalog_product_registrations r
       WHERE r.product_id IS NOT NULL`,
    );

    const byProduct = new Map<string, RegistryRow[]>();
    for (const row of registry.rows) {
      const list = byProduct.get(row.product_id) ?? [];
      list.push({ manufacturer: row.manufacturer, status: row.status ?? "", valid: row.valid, importedAt: row.imported_at });
      byProduct.set(row.product_id, list);
    }

    // 2. Respaldo por número de registro para productos sin filas vinculadas.
    const unlinked = await client.query<{ id: string; name: string; registration: string | null; manufacturer: string; imported_at: string | null }>(
      `SELECT p.id, p.product_name AS name, p.sanitary_registration AS registration,
              btrim(rt.manufacturer_name) AS manufacturer, rt.imported_at
       FROM farmacia.catalog_products p
       CROSS JOIN LATERAL (
         SELECT r.manufacturer_name, r.imported_at
         FROM farmacia.catalog_product_registrations r
         WHERE r.sanitary_registration = p.sanitary_registration
           AND btrim(r.manufacturer_name) IS NOT NULL
           AND upper(btrim(r.manufacturer_name)) NOT IN ('N/D', 'ND', 'S/D', 'N/A', 'NO DISPONIBLE')
         ORDER BY (r.registration_status = 'VIGENTE') DESC, r.imported_at DESC
         LIMIT 1
       ) rt
       WHERE p.is_active
         AND NOT EXISTS (SELECT 1 FROM farmacia.catalog_product_registrations r2 WHERE r2.product_id = p.id)`,
    );

    // 3. Productos activos.
    const products = await client.query<{ id: string; name: string; registration: string | null; current_lab: string | null }>(
      `SELECT p.id, p.product_name AS name, p.sanitary_registration AS registration,
              l.name AS current_lab
       FROM farmacia.catalog_products p
       LEFT JOIN farmacia.laboratories l ON l.id = p.manufacturer_id
       WHERE p.is_active`,
    );

    const linkedNames = unlinked.rows.length;

    interface PlanEntry { productId: string; productName: string; labKey: string; labDisplay: string; alreadySet: boolean }
    const plan: PlanEntry[] = [];
    const noSource: string[] = [];

    for (const product of products.rows) {
      const fromLinked = byProduct.get(product.id);
      const fallback = unlinked.rows
        .filter((row) => row.id === product.id)
        .map((row) => ({ manufacturer: row.manufacturer, status: "", valid: true, importedAt: row.imported_at }));
      const chosen = pickManufacturer(fromLinked ?? []) ?? pickManufacturer(fallback);
      if (chosen === null) {
        noSource.push(product.name);
        continue;
      }
      if (product.current_lab !== null) {
        // Ya tiene fabricante asignado: no se sobrescribe.
        continue;
      }
      plan.push({
        productId: product.id,
        productName: product.name,
        labKey: canonicalLabKey(chosen),
        labDisplay: chosen,
        alreadySet: false,
      });
    }

    // 4. Unificación de laboratorios: llave canónica -> nombre visible más frecuente.
    const labsByCanonical = new Map<string, Map<string, number>>();
    for (const entry of plan) {
      const variants = labsByCanonical.get(entry.labKey) ?? new Map<string, number>();
      variants.set(entry.labDisplay, (variants.get(entry.labDisplay) ?? 0) + 1);
      labsByCanonical.set(entry.labKey, variants);
    }
    const showcaseName = new Map<string, string>();
    for (const [key, variants] of labsByCanonical) {
      const best = Array.from(variants.entries()).sort((a, b) => b[1] - a[1])[0][0];
      showcaseName.set(key, best);
    }

    console.log("=== IMPORTACIÓN DE MARCA (fabricante del registro oficial) ===");
    console.log(`Productos activos: ${products.rows.length}`);
    console.log(`Filas del registro vinculadas directamente: ${byProduct.size}`);
    console.log(`Productos resolvibles solo por número de registro: ${linkedNames}`);
    console.log(`Laboratorios distintos tras unificar variantes: ${labsByCanonical.size}`);
    console.log(`Sin fabricante en el registro (quedan sin marca): ${noSource.length}`);
    console.log(`Modo: ${APPLY ? "APLICAR" : "SIMULACIÓN (no se modifica nada)"}`);

    const samples = Array.from(showcaseName.entries()).slice(0, 10);
    console.log("\nMuestra de laboratorios a crear:");
    for (const [key, display] of samples) console.log(`  ${key} => ${display}`);

    if (!APPLY) {
      await client.query("ROLLBACK");
      return;
    }

    // Respaldo: marca asignada por producto (para trazabilidad).
    const dir = join(ROOT, "backups");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const backupFile = join(dir, `catalogo-marcas-${Date.now()}.json`);
    writeFileSync(
      backupFile,
      JSON.stringify({ note: "Marca elegida del registro oficial por producto", products: plan.map((item) => ({ id: item.productId, name: item.productName, laboratory: item.labDisplay })) }, null, 2),
    );

    // 5. Crear laboratorios en lotes.
    const labId = new Map<string, string>();
    const keys = Array.from(showcaseName.keys());
    for (let offset = 0; offset < keys.length; offset += 500) {
      const batch = keys.slice(offset, offset + 500);
      const values = batch.map((_, index) => `($${index * 2 + 1}, $${index * 2 + 2}, true, NOW(), NOW())`).join(", ");
      const params: string[] = [];
      batch.forEach((key, index) => {
        // name = etiqueta visible; normalized_name = llave canónica en minúsculas.
        params.push(showcaseName.get(key) ?? key, key.toLowerCase());
      });
      const inserted = await client.query<{ id: string; normalized_name: string }>(
        `INSERT INTO farmacia.laboratories (name, normalized_name, is_active, created_at, updated_at)
         VALUES ${values}
         ON CONFLICT (normalized_name) DO NOTHING
         RETURNING id, normalized_name`,
        params,
      );
      for (const row of inserted.rows) labId.set(row.normalized_name, row.id);
      const existing = await client.query<{ id: string; normalized_name: string }>(
        `SELECT id, normalized_name FROM farmacia.laboratories WHERE normalized_name = ANY($1::varchar[])`,
        [batch.map((key) => key.toLowerCase())],
      );
      for (const row of existing.rows) labId.set(row.normalized_name, row.id);
    }
    console.log(`Laboratorios disponibles: ${labId.size}`);

    // 6. Asignar: tabla temporal + un solo UPDATE.
    await client.query("CREATE TEMP TABLE tmp_brand_map (product_id uuid, lab_id uuid) ON COMMIT DROP");
    for (let offset = 0; offset < plan.length; offset += 1000) {
      const batch = plan.slice(offset, offset + 1000);
      const values: string[] = [];
      const params: string[] = [];
      batch.forEach((item, index) => {
        const lab = labId.get(canonicalLabKey(item.labDisplay).toLowerCase());
        if (!lab) return;
        values.push(`($${index * 2 + 1}::uuid, $${index * 2 + 2}::uuid)`);
        params.push(item.productId, lab);
      });
      if (values.length > 0) {
        await client.query(`INSERT INTO tmp_brand_map (product_id, lab_id) VALUES ${values.join(", ")}`, params);
      }
    }

    const updated = await client.query<{ n: number }>(
      `WITH assignments AS (
         SELECT tmp.product_id, tmp.lab_id
         FROM tmp_brand_map tmp
         INNER JOIN farmacia.catalog_products p ON p.id = tmp.product_id
         WHERE p.manufacturer_id IS NULL
       )
       UPDATE farmacia.catalog_products p
       SET manufacturer_id = a.lab_id, updated_at = NOW()
       FROM assignments a
       WHERE p.id = a.product_id
       RETURNING 1 AS n`,
    );

    // 7. Auditoría del lote.
    await client.query(
      `INSERT INTO farmacia.audit_logs (actor_user_id, action, entity, entity_id, old_values, new_values)
       VALUES (NULL, 'catalog.manufacturer_import', 'catalog_batch', NULL, $1::jsonb, $2::jsonb)`,
      [
        JSON.stringify({ products_with_manufacturer_before: products.rows.filter((row) => row.current_lab !== null).length }),
        JSON.stringify({ products_updated: updated.rows.length, laboratories_created: labId.size, without_source: noSource.length, source: "MISPAS registro sanitario 2018-2026 (columna Fabricante)" }),
      ],
    );

    await client.query("COMMIT");

    console.log(`\nAPLICADO. Respaldo: ${backupFile}`);
    console.log(`Marcas asignadas: ${updated.rows[0]?.n ?? 0} · Laboratorios: ${labId.size} · Sin marca (sin fuente): ${noSource.length}`);
    if (noSource.length > 0) {
      console.log("Sin fabricante publicado en el registro (ejemplo de 15):");
      for (const name of noSource.slice(0, 15)) console.log(`  - ${name}`);
    }
  } catch (error) {
    const failed = client as { query?: (sql: string) => Promise<unknown> };
    await failed.query?.("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

void main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
