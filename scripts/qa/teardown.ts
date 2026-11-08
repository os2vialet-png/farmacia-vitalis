/**
 * Cierre de pruebas QA.
 *
 *   npx tsx scripts/qa/teardown.ts                     # desactiva cuentas, productos y sucursal QA (reversible)
 *   npx tsx scripts/qa/teardown.ts --purge             # muestra qué datos transaccionales QA se borrarían
 *   npx tsx scripts/qa/teardown.ts --purge --confirm   # los borra (NO se puede deshacer)
 *
 * Identificación de datos QA: productos con source_external_id 'QA-TEST-%', usuarios 'qa_%', sucursal 'QA-002'.
 * No se borran: usuarios, productos, verificaciones, consentimientos ni auditoría (historiales inmutables);
 * esos quedan desactivados.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";

const ROOT = resolve(__dirname, "..", "..");
const PURGE = process.argv.includes("--purge");
const CONFIRM = process.argv.includes("--confirm");

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

    const qaProducts = (await client.query<{ id: string }>(
      `SELECT id FROM farmacia.catalog_products WHERE source_external_id LIKE 'QA-TEST-%'`,
    )).rows.map((row) => row.id);

    const qaUsers = (await client.query<{ id: string }>(
      `SELECT id FROM farmacia.users WHERE username LIKE 'qa\\_%'`,
    )).rows.map((row) => row.id);

    if (PURGE) {
      // Seguridad: ninguna operación puede mezclar productos QA con productos reales.
      const mixed = await client.query<{ kind: string; n: number }>(
        `SELECT 'ventas' AS kind, COUNT(DISTINCT si.sale_id)::int AS n
         FROM farmacia.sale_items si
         WHERE si.sale_id IN (SELECT sale_id FROM farmacia.sale_items WHERE product_id = ANY($1::uuid[]))
           AND NOT (si.product_id = ANY($1::uuid[]))
         UNION ALL
         SELECT 'compras', COUNT(DISTINCT poi.purchase_order_id)::int
         FROM farmacia.purchase_order_items poi
         WHERE poi.purchase_order_id IN (SELECT purchase_order_id FROM farmacia.purchase_order_items WHERE product_id = ANY($1::uuid[]))
           AND NOT (poi.product_id = ANY($1::uuid[]))
         UNION ALL
         SELECT 'transferencias', COUNT(DISTINCT ti.transfer_id)::int
         FROM farmacia.transfer_items ti
         WHERE ti.transfer_id IN (SELECT transfer_id FROM farmacia.transfer_items WHERE product_id = ANY($1::uuid[]))
           AND NOT (ti.product_id = ANY($1::uuid[]))`,
        [qaProducts],
      );

      const unsafe = mixed.rows.filter((row) => row.n > 0);
      if (unsafe.length > 0) {
        throw new Error(`Hay operaciones que mezclan productos QA y reales: ${JSON.stringify(unsafe)}. No se borra nada.`);
      }

      const counts = await client.query(
        `SELECT
           (SELECT COUNT(DISTINCT sale_id) FROM farmacia.sale_items WHERE product_id = ANY($1::uuid[]))::int AS ventas,
           (SELECT COUNT(DISTINCT purchase_order_id) FROM farmacia.purchase_order_items WHERE product_id = ANY($1::uuid[]))::int AS compras,
           (SELECT COUNT(DISTINCT transfer_id) FROM farmacia.transfer_items WHERE product_id = ANY($1::uuid[]))::int AS transferencias,
           (SELECT COUNT(*) FROM farmacia.inventory_lots WHERE product_id = ANY($1::uuid[]))::int AS lotes,
           (SELECT COUNT(*) FROM farmacia.inventory_movements WHERE product_id = ANY($1::uuid[]))::int AS movimientos,
           (SELECT COUNT(*) FROM farmacia.product_branch_prices WHERE product_id = ANY($1::uuid[]))::int AS precios`,
        [qaProducts],
      );

      console.log("Datos transaccionales QA:", JSON.stringify(counts.rows[0]));

      if (!CONFIRM) {
        await client.query("ROLLBACK");
        console.log("Simulación: no se borró nada. Agrega --confirm para borrar (no se puede deshacer).");
        return;
      }

      const sales = `(SELECT DISTINCT sale_id FROM farmacia.sale_items WHERE product_id = ANY($1::uuid[]))`;
      const transfers = `(SELECT DISTINCT transfer_id FROM farmacia.transfer_items WHERE product_id = ANY($1::uuid[]))`;

      await client.query(`DELETE FROM farmacia.inventory_movements WHERE product_id = ANY($1::uuid[])`, [qaProducts]);
      await client.query(`DELETE FROM farmacia.sale_item_lots WHERE sale_item_id IN (SELECT id FROM farmacia.sale_items WHERE sale_id IN ${sales})`, [qaProducts]);
      await client.query(`DELETE FROM farmacia.sale_payments WHERE sale_id IN ${sales}`, [qaProducts]);
      await client.query(`CREATE TEMP TABLE qa_sales ON COMMIT DROP AS SELECT DISTINCT sale_id AS id FROM farmacia.sale_items WHERE product_id = ANY($1::uuid[])`, [qaProducts]);
      await client.query(`DELETE FROM farmacia.sale_items WHERE sale_id IN (SELECT id FROM qa_sales)`);
      await client.query(`DELETE FROM farmacia.sales WHERE id IN (SELECT id FROM qa_sales)`);

      await client.query(`DELETE FROM farmacia.transfer_item_lots WHERE transfer_item_id IN (SELECT id FROM farmacia.transfer_items WHERE transfer_id IN ${transfers})`, [qaProducts]);
      await client.query(`CREATE TEMP TABLE qa_transfers ON COMMIT DROP AS SELECT DISTINCT transfer_id AS id FROM farmacia.transfer_items WHERE product_id = ANY($1::uuid[])`, [qaProducts]);
      await client.query(`DELETE FROM farmacia.transfer_items WHERE transfer_id IN (SELECT id FROM qa_transfers)`);
      await client.query(`DELETE FROM farmacia.transfers WHERE id IN (SELECT id FROM qa_transfers)`);

      await client.query(`CREATE TEMP TABLE qa_orders ON COMMIT DROP AS SELECT DISTINCT purchase_order_id AS id FROM farmacia.purchase_order_items WHERE product_id = ANY($1::uuid[])`, [qaProducts]);
      await client.query(`DELETE FROM farmacia.purchase_receipt_items WHERE purchase_order_item_id IN (SELECT id FROM farmacia.purchase_order_items WHERE purchase_order_id IN (SELECT id FROM qa_orders))`);
      await client.query(`DELETE FROM farmacia.purchase_receipts WHERE purchase_order_id IN (SELECT id FROM qa_orders)`);
      await client.query(`DELETE FROM farmacia.purchase_order_items WHERE purchase_order_id IN (SELECT id FROM qa_orders)`);
      await client.query(`DELETE FROM farmacia.purchase_orders WHERE id IN (SELECT id FROM qa_orders)`);

      await client.query(`DELETE FROM farmacia.inventory_lots WHERE product_id = ANY($1::uuid[])`, [qaProducts]);
      await client.query(`DELETE FROM farmacia.inventory_stock WHERE product_id = ANY($1::uuid[])`, [qaProducts]);
      await client.query(`DELETE FROM farmacia.product_branch_prices WHERE product_id = ANY($1::uuid[])`, [qaProducts]);

      await client.query(
        `INSERT INTO farmacia.audit_logs (actor_user_id, action, entity, new_values)
         VALUES (NULL, 'qa.purge', 'qa_data', $1::jsonb)`,
        [JSON.stringify(counts.rows[0])],
      );
    }

    // Desactivación (reversible): cuentas, sesiones, productos, clientes de prueba y sucursal QA.
    await client.query(`UPDATE farmacia.users SET is_active = FALSE WHERE id = ANY($1::uuid[])`, [qaUsers]);
    await client.query(`UPDATE farmacia.user_sessions SET revoked_at = NOW() WHERE user_id = ANY($1::uuid[]) AND revoked_at IS NULL`, [qaUsers]);
    await client.query(`UPDATE farmacia.catalog_products SET is_active = FALSE WHERE id = ANY($1::uuid[])`, [qaProducts]);
    await client.query(`UPDATE farmacia.customers SET is_active = FALSE WHERE created_by = ANY($1::uuid[])`, [qaUsers]);
    await client.query(`UPDATE farmacia.branches SET is_active = FALSE WHERE code = 'QA-002'`);

    await client.query("COMMIT");

    const accountsFile = join(ROOT, "backups", "qa-accounts.json");
    if (existsSync(accountsFile)) unlinkSync(accountsFile);

    console.log(`Cuentas QA desactivadas: ${qaUsers.length}. Productos QA desactivados: ${qaProducts.length}.`);
    console.log("Sucursal QA-002 desactivada y archivo de contraseñas de prueba eliminado.");
    if (PURGE && CONFIRM) console.log("Datos transaccionales QA eliminados.");
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
