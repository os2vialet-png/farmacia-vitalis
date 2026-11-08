/**
 * Verificación posterior a la purga de datos QA.
 *
 *   npx tsx --env-file=.env.local scripts/qa/verify-purge.ts
 *
 * Comprueba que no queden transacciones QA en el sistema y que los
 * totales de la base de datos sean coherentes. Solo lectura.
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
    const totals = await client.query<{ row: Record<string, number> }>(
      `SELECT
        (SELECT COUNT(*) FROM farmacia.sales)::int AS ventas,
        (SELECT COUNT(*) FROM farmacia.purchase_orders)::int AS compras,
        (SELECT COUNT(*) FROM farmacia.transfers)::int AS transferencias,
        (SELECT COUNT(*) FROM farmacia.inventory_lots)::int AS lotes,
        (SELECT COUNT(*) FROM farmacia.inventory_movements)::int AS movimientos,
        (SELECT COUNT(*) FROM farmacia.customers)::int AS clientes,
        (SELECT COUNT(*) FROM farmacia.catalog_products WHERE is_active)::int AS productos_activos,
        (SELECT COUNT(*) FROM farmacia.catalog_products WHERE is_active AND verification_status = 'verified')::int AS productos_verificados,
        (SELECT COUNT(*) FROM farmacia.branches WHERE is_active)::int AS sucursales,
        (SELECT COUNT(*) FROM farmacia.users WHERE is_active)::int AS usuarios_activos`,
    );
    console.log("Totales actuales:", JSON.stringify(totals.rows[0]));

    const qaLeftover = await client.query<{ table: string; n: number }>(
      `SELECT 'ventas_qa' AS table, COUNT(*)::int AS n FROM farmacia.sales s
        JOIN farmacia.sale_items si ON si.sale_id = s.id
        JOIN farmacia.catalog_products p ON p.id = si.product_id
        WHERE p.source_external_id LIKE 'QA-TEST-%'
       UNION ALL
       SELECT 'lotes_qa', COUNT(*)::int FROM farmacia.inventory_lots l
        JOIN farmacia.catalog_products p ON p.id = l.product_id
        WHERE p.source_external_id LIKE 'QA-TEST-%'
       UNION ALL
       SELECT 'movimientos_qa', COUNT(*)::int FROM farmacia.inventory_movements m
        JOIN farmacia.catalog_products p ON p.id = m.product_id
        WHERE p.source_external_id LIKE 'QA-TEST-%'
       UNION ALL
       SELECT 'precios_qa', COUNT(*)::int FROM farmacia.product_branch_prices pp
        JOIN farmacia.catalog_products p ON p.id = pp.product_id
        WHERE p.source_external_id LIKE 'QA-TEST-%'`,
    );
    const restante = qaLeftover.rows.filter((row) => row.n > 0);
    if (restante.length > 0) {
      console.error("QUEDAN DATOS QA:", JSON.stringify(restante));
      process.exitCode = 1;
    } else {
      console.log("Sin restingos QA transaccionales. Purga verificada.");
    }

    const clientes = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE is_active)::int AS activos,
         COUNT(*) FILTER (WHERE NOT is_active)::int AS inactivos,
         COUNT(*) FILTER (WHERE cu.created_by IN (SELECT id FROM farmacia.users WHERE username LIKE 'qa\\_%'))::int AS creados_por_qa,
         COUNT(*)::int AS total
       FROM farmacia.customers cu`,
    );
    console.log("Clientes:", JSON.stringify(clientes.rows[0]));

    const integridad = await client.query<{ check: string; n: number }>(
      `SELECT 'ventas_sin_items' AS check, COUNT(*)::int AS n FROM farmacia.sales s
        WHERE NOT EXISTS (SELECT 1 FROM farmacia.sale_items si WHERE si.sale_id = s.id)
       UNION ALL
       SELECT 'ordenes_sin_items', COUNT(*)::int FROM farmacia.purchase_orders o
        WHERE NOT EXISTS (SELECT 1 FROM farmacia.purchase_order_items oi WHERE oi.purchase_order_id = o.id)
       UNION ALL
       SELECT 'transferencias_sin_items', COUNT(*)::int FROM farmacia.transfers t
        WHERE NOT EXISTS (SELECT 1 FROM farmacia.transfer_items ti WHERE ti.transfer_id = t.id)
       UNION ALL
       SELECT 'ventas_sin_pagos', COUNT(*)::int FROM farmacia.sales s
        WHERE NOT EXISTS (SELECT 1 FROM farmacia.sale_payments sp WHERE sp.sale_id = s.id)`,
    );
    const rotas = integridad.rows.filter((row) => row.n > 0);
    if (rotas.length > 0) {
      console.error("INTEGRIDAD ROTAS:", JSON.stringify(rotas));
      process.exitCode = 1;
    } else {
      console.log("Integridad referencial correcta tras la purga.");
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
