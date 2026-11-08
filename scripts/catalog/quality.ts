/**
 * Calidad de datos del catálogo (Fase 7).
 *
 *   npx tsx scripts/catalog/quality.ts            # simulación: no modifica nada
 *   npx tsx scripts/catalog/quality.ts --apply    # aplica los cambios planificados
 *
 * Qué hace:
 * 1. Duplicados exactos (mismo nombre normalizado, registro, forma, concentración y presentación):
 *    conserva el registro con más referencias (lotes, compras, ventas, transferencias) y,
 *    en empate, el más antiguo. Al duplicado le marca duplicate_of_product_id y lo desactiva,
 *    salvo que tenga existencias: en ese caso se reporta para fusión manual.
 * 2. Presentación vacía: se completa solo desde la descripción de empaque del registro oficial
 *    vigente, con el mismo número de registro y nombre. Nunca se sobrescribe un valor existente.
 *
 * Qué NO hace: no inventa marcas, concentraciones ni unidades de venta, y no verifica productos.
 *
 * Seguridad: un respaldo JSON del estado previo se guarda en backups/. Todo corre en una transacción
 * y cada cambio queda en farmacia.audit_logs.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";

const ROOT = resolve(__dirname, "..", "..");
const APPLY = process.argv.includes("--apply");

function loadDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const match = readFileSync(join(ROOT, ".env.local"), "utf8").match(/^DATABASE_URL=(.*)$/m);
  if (!match) throw new Error("Falta DATABASE_URL.");
  return match[1].trim().replace(/^"|"$/g, "");
}

type Group = { ids: string[]; normalized_name: string };

async function main() {
  const client = new Client({ connectionString: loadDatabaseUrl() });
  await client.connect();

  try {
    await client.query("BEGIN");

    // Estado previo de lo que puede cambiar, para respaldo.
    const groups = await client.query<Group & { sanitary_registration: string | null }>(
      `SELECT normalized_name, sanitary_registration, array_agg(id ORDER BY created_at, id) AS ids
       FROM farmacia.catalog_products
       WHERE duplicate_of_product_id IS NULL
       GROUP BY normalized_name, sanitary_registration, dosage_form, strength, presentation
       HAVING COUNT(*) > 1`,
    );

    const refs = await client.query<{ id: string; refs: number; stock_on_hand: string }>(
      `SELECT p.id,
              ((SELECT COUNT(*) FROM farmacia.inventory_lots l WHERE l.product_id = p.id)
            + (SELECT COUNT(*) FROM farmacia.purchase_order_items poi WHERE poi.product_id = p.id)
            + (SELECT COUNT(*) FROM farmacia.sale_items si WHERE si.product_id = p.id)
            + (SELECT COUNT(*) FROM farmacia.transfer_items ti WHERE ti.product_id = p.id))::int AS refs,
              COALESCE((SELECT SUM(quantity_on_hand) FROM farmacia.inventory_stock s WHERE s.product_id = p.id), 0)::text AS stock_on_hand
       FROM farmacia.catalog_products p`,
    );
    const refMap = new Map(refs.rows.map((row) => [row.id, row]));

    const plannedDeactivations: { duplicateId: string; keeperId: string; name: string }[] = [];
    const manualMerge: { name: string; ids: string[]; reason: string }[] = [];

    for (const group of groups.rows) {
      const ranked = [...group.ids].sort((a, b) => {
        const ra = refMap.get(a)?.refs ?? 0;
        const rb = refMap.get(b)?.refs ?? 0;
        if (ra !== rb) return rb - ra;
        return group.ids.indexOf(a) - group.ids.indexOf(b);
      });
      const keeperId = ranked[0];

      for (const duplicateId of ranked.slice(1)) {
        const stock = Number(refMap.get(duplicateId)?.stock_on_hand ?? 0);
        if (stock > 0) {
          manualMerge.push({ name: group.normalized_name, ids: [keeperId, duplicateId], reason: "el duplicado tiene existencias" });
        } else {
          plannedDeactivations.push({ duplicateId, keeperId, name: group.normalized_name });
        }
      }
    }

    // Presentación vacía desde el registro oficial vigente.
    const presentationCandidates = await client.query<{ id: string; name: string; presentation: string }>(
      `SELECT DISTINCT ON (p.id) p.id, p.product_name AS name, btrim(r.package_description) AS presentation
       FROM farmacia.catalog_products p
       INNER JOIN farmacia.catalog_product_registrations r
         ON r.sanitary_registration = p.sanitary_registration
        AND btrim(regexp_replace(lower(r.product_name), '[^a-z0-9]+', ' ', 'g'))
            = btrim(regexp_replace(lower(p.product_name), '[^a-z0-9]+', ' ', 'g'))
       WHERE (p.presentation IS NULL OR btrim(p.presentation) = '')
         AND r.registration_status = 'VIGENTE'
         AND (r.expiration_date IS NULL OR r.expiration_date >= CURRENT_DATE)
         AND r.package_description IS NOT NULL AND btrim(r.package_description) <> ''
       ORDER BY p.id, r.imported_at DESC`,
    );

    const presentationPlan = presentationCandidates.rows.map((row) => ({
      id: row.id,
      name: row.name,
      presentation: row.presentation.slice(0, 150),
    }));

    console.log("=== PLAN DE CALIDAD DEL CATÁLOGO ===");
    console.log(`Grupos de duplicados exactos: ${groups.rows.length}`);
    console.log(`Duplicados a desactivar (con referencia al registro conservado): ${plannedDeactivations.length}`);
    console.log(`Duplicados con existencias (fusión manual): ${manualMerge.length}`);
    console.log(`Presentaciones a completar desde el registro oficial: ${presentationPlan.length}`);
    console.log(`Modo: ${APPLY ? "APLICAR" : "SIMULACIÓN (no se modifica nada)"}`);

    if (!APPLY) {
      await client.query("ROLLBACK");
      console.log("\nEjemplo de desactivación:", JSON.stringify(plannedDeactivations.slice(0, 2)));
      return;
    }

    const dir = join(ROOT, "backups");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const backupFile = join(dir, `catalogo-antes-calidad-${Date.now()}.json`);

    const beforeRows = await client.query(
      `SELECT id, is_active, presentation, duplicate_of_product_id, verification_status
       FROM farmacia.catalog_products
       WHERE id = ANY($1::uuid[]) OR id = ANY($2::uuid[])`,
      [plannedDeactivations.map((item) => item.duplicateId), presentationPlan.map((item) => item.id)],
    );
    writeFileSync(backupFile, JSON.stringify(beforeRows.rows, null, 2));

    for (const item of plannedDeactivations) {
      await client.query(
        `UPDATE farmacia.catalog_products
         SET is_active = FALSE, duplicate_of_product_id = $2, updated_at = NOW()
         WHERE id = $1`,
        [item.duplicateId, item.keeperId],
      );
      await client.query(
        `INSERT INTO farmacia.audit_logs (actor_user_id, action, entity, entity_id, old_values, new_values)
         VALUES (NULL, 'catalog.deduplicate', 'catalog_product', $1, $2::jsonb, $3::jsonb)`,
        [
          item.duplicateId,
          JSON.stringify({ isActive: true }),
          JSON.stringify({ isActive: false, keeperProductId: item.keeperId, criterion: "duplicado exacto; se conserva el de más referencias y el más antiguo" }),
        ],
      );
    }

    for (const item of presentationPlan) {
      await client.query(
        `UPDATE farmacia.catalog_products SET presentation = $2, updated_at = NOW()
         WHERE id = $1 AND (presentation IS NULL OR btrim(presentation) = '')`,
        [item.id, item.presentation],
      );
      await client.query(
        `INSERT INTO farmacia.audit_logs (actor_user_id, action, entity, entity_id, old_values, new_values)
         VALUES (NULL, 'catalog.presentation_from_registry', 'catalog_product', $1, $2::jsonb, $3::jsonb)`,
        [item.id, JSON.stringify({ presentation: null }), JSON.stringify({ presentation: item.presentation, source: "DIGEMAPS registro vigente: descripción de empaque" })],
      );
    }

    await client.query("COMMIT");

    console.log(`\nAPLICADO. Respaldo: ${backupFile}`);
    console.log(`Desactivados: ${plannedDeactivations.length} · Presentaciones completadas: ${presentationPlan.length}`);
    if (manualMerge.length > 0) {
      console.log("Pendientes de fusión manual (tienen existencias):");
      for (const item of manualMerge) console.log(`  - ${item.name}: ${item.ids.join(" / ")}`);
    }
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
