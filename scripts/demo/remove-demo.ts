/**
 * Borra los datos de DEMOSTRACIÓN creados por seed-demo.ts.
 *
 *   npx tsx scripts/demo/remove-demo.ts             # muestra qué se borraría (no cambia nada)
 *   npx tsx scripts/demo/remove-demo.ts --confirm   # lo borra (no se puede deshacer)
 *
 * Borra ventas, compras, transferencias, lotes, movimientos, existencias y precios de los productos
 * "DEMO-*". Desactiva (no borra) esos productos, los empleados demo_*, los clientes y suplidores demo,
 * porque historiales inmutables (verificaciones, consentimientos, auditoría) los referencian.
 * No toca la sucursal demo (se desactiva aparte). Aborta si una operación mezcla productos demo y reales.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";

const ROOT = resolve(__dirname, "..", "..");
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

    const products = (await client.query<{ id: string }>(
      `SELECT id FROM farmacia.catalog_products WHERE source_external_id LIKE 'DEMO-%'`,
    )).rows.map((row) => row.id);

    const mixed = await client.query<{ n: number }>(
      `SELECT (
         (SELECT COUNT(*) FROM farmacia.sale_items si
           WHERE si.sale_id IN (SELECT sale_id FROM farmacia.sale_items WHERE product_id = ANY($1::uuid[]))
             AND NOT (si.product_id = ANY($1::uuid[])))
       + (SELECT COUNT(*) FROM farmacia.purchase_order_items poi
           WHERE poi.purchase_order_id IN (SELECT purchase_order_id FROM farmacia.purchase_order_items WHERE product_id = ANY($1::uuid[]))
             AND NOT (poi.product_id = ANY($1::uuid[])))
       + (SELECT COUNT(*) FROM farmacia.transfer_items ti
           WHERE ti.transfer_id IN (SELECT transfer_id FROM farmacia.transfer_items WHERE product_id = ANY($1::uuid[]))
             AND NOT (ti.product_id = ANY($1::uuid[])))
       )::int AS n`,
      [products],
    );
    if (mixed.rows[0].n > 0) throw new Error("Hay operaciones que mezclan productos demo y reales. No se borra nada.");

    const counts = await client.query(
      `SELECT
         (SELECT COUNT(DISTINCT sale_id) FROM farmacia.sale_items WHERE product_id = ANY($1::uuid[]))::int AS ventas,
         (SELECT COUNT(DISTINCT purchase_order_id) FROM farmacia.purchase_order_items WHERE product_id = ANY($1::uuid[]))::int AS compras,
         (SELECT COUNT(DISTINCT transfer_id) FROM farmacia.transfer_items WHERE product_id = ANY($1::uuid[]))::int AS transferencias,
         (SELECT COUNT(*) FROM farmacia.inventory_lots WHERE product_id = ANY($1::uuid[]))::int AS lotes,
         (SELECT COUNT(*) FROM farmacia.users WHERE username LIKE 'demo\\_%' AND is_active)::int AS empleados_activos,
         (SELECT COUNT(*) FROM farmacia.customers WHERE full_name LIKE '%(demo)' AND is_active)::int AS clientes,
         (SELECT COUNT(*) FROM farmacia.suppliers WHERE name LIKE '%(demo)' AND is_active)::int AS suplidores`,
      [products],
    );
    console.log("Datos de demostración:", JSON.stringify(counts.rows[0]));

    if (!CONFIRM) {
      await client.query("ROLLBACK");
      console.log("Simulación: no se borró nada. Agrega --confirm para borrar (no se puede deshacer).");
      return;
    }

    await client.query(`CREATE TEMP TABLE demo_sales ON COMMIT DROP AS SELECT DISTINCT sale_id AS id FROM farmacia.sale_items WHERE product_id = ANY($1::uuid[])`, [products]);
    await client.query(`CREATE TEMP TABLE demo_orders ON COMMIT DROP AS SELECT DISTINCT purchase_order_id AS id FROM farmacia.purchase_order_items WHERE product_id = ANY($1::uuid[])`, [products]);
    await client.query(`CREATE TEMP TABLE demo_transfers ON COMMIT DROP AS SELECT DISTINCT transfer_id AS id FROM farmacia.transfer_items WHERE product_id = ANY($1::uuid[])`, [products]);

    await client.query(`DELETE FROM farmacia.inventory_movements WHERE product_id = ANY($1::uuid[])`, [products]);
    await client.query(`DELETE FROM farmacia.sale_item_lots WHERE sale_item_id IN (SELECT id FROM farmacia.sale_items WHERE sale_id IN (SELECT id FROM demo_sales))`);
    await client.query(`DELETE FROM farmacia.sale_payments WHERE sale_id IN (SELECT id FROM demo_sales)`);
    await client.query(`DELETE FROM farmacia.sale_items WHERE sale_id IN (SELECT id FROM demo_sales)`);
    await client.query(`DELETE FROM farmacia.sales WHERE id IN (SELECT id FROM demo_sales)`);
    await client.query(`DELETE FROM farmacia.transfer_item_lots WHERE transfer_item_id IN (SELECT id FROM farmacia.transfer_items WHERE transfer_id IN (SELECT id FROM demo_transfers))`);
    await client.query(`DELETE FROM farmacia.transfer_items WHERE transfer_id IN (SELECT id FROM demo_transfers)`);
    await client.query(`DELETE FROM farmacia.transfers WHERE id IN (SELECT id FROM demo_transfers)`);
    await client.query(`DELETE FROM farmacia.purchase_receipt_items WHERE purchase_order_item_id IN (SELECT id FROM farmacia.purchase_order_items WHERE purchase_order_id IN (SELECT id FROM demo_orders))`);
    await client.query(`DELETE FROM farmacia.purchase_receipts WHERE purchase_order_id IN (SELECT id FROM demo_orders)`);
    await client.query(`DELETE FROM farmacia.purchase_order_items WHERE purchase_order_id IN (SELECT id FROM demo_orders)`);
    await client.query(`DELETE FROM farmacia.purchase_orders WHERE id IN (SELECT id FROM demo_orders)`);
    await client.query(`DELETE FROM farmacia.inventory_lots WHERE product_id = ANY($1::uuid[])`, [products]);
    await client.query(`DELETE FROM farmacia.inventory_stock WHERE product_id = ANY($1::uuid[])`, [products]);
    await client.query(`DELETE FROM farmacia.product_branch_prices WHERE product_id = ANY($1::uuid[])`, [products]);

    await client.query(`UPDATE farmacia.catalog_products SET is_active = FALSE WHERE id = ANY($1::uuid[])`, [products]);
    await client.query(`UPDATE farmacia.user_sessions SET revoked_at = NOW() WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM farmacia.users WHERE username LIKE 'demo\\_%')`);
    await client.query(`UPDATE farmacia.users SET is_active = FALSE WHERE username LIKE 'demo\\_%'`);
    await client.query(`UPDATE farmacia.customers SET is_active = FALSE WHERE full_name LIKE '%(demo)'`);
    await client.query(`UPDATE farmacia.suppliers SET is_active = FALSE WHERE name LIKE '%(demo)'`);

    await client.query(
      `INSERT INTO farmacia.audit_logs (actor_user_id, action, entity, new_values) VALUES (NULL, 'demo.remove', 'demo_data', $1::jsonb)`,
      [JSON.stringify(counts.rows[0])],
    );

    await client.query("COMMIT");
    console.log("Datos de demostración eliminados.");
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
