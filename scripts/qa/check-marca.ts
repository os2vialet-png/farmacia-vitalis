/**
 * Diagnóstico: cobertura de manufacturer_name en el registro sanitario (MISPAS) en la base.
 */
import { Pool } from "pg";

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const stats = await pool.query<Record<string, string | number>>(`
      SELECT
        COUNT(*)::int AS registros,
        COUNT(manufacturer_name)::int AS con_fabricante,
        COUNT(DISTINCT manufacturer_name)::int AS fabricantes_distintos,
        COUNT(DISTINCT distributor_name)::int AS distribuidoras_distintas,
        COUNT(product_id)::int AS vinculados_a_producto
      FROM farmacia.catalog_product_registrations
    `);
    console.log("REGISTRO:", JSON.stringify(stats.rows[0], null, 2));

    const coverage = await pool.query<Record<string, string | number>>(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(r.manufacturer_name)::int AS con_fabricante_representante
      FROM farmacia.catalog_products p
      LEFT JOIN LATERAL (
        SELECT r.manufacturer_name
        FROM farmacia.catalog_product_registrations r
        WHERE r.product_id = p.id OR (r.sanitary_registration = p.sanitary_registration)
        ORDER BY CASE WHEN r.registration_status = 'VIGENTE' THEN 0 ELSE 1 END, r.imported_at DESC
        LIMIT 1
      ) r ON TRUE
      WHERE p.is_active
    `);
    console.log("PRODUCTOS:", JSON.stringify(coverage.rows[0], null, 2));

    const top = await pool.query<{ manufacturer: string; n: number }>(
      `SELECT manufacturer_name AS manufacturer, COUNT(*)::int AS n
       FROM farmacia.catalog_product_registrations
       WHERE manufacturer_name IS NOT NULL
       GROUP BY manufacturer_name ORDER BY n DESC LIMIT 12`,
    );
    console.log("\nTOP FABRICANTES EN EL REGISTRO:");
    for (const row of top.rows) console.log(`${row.manufacturer}: ${row.n}`);

    const sample = await pool.query<Record<string, string | null>>(`
      SELECT p.product_name, p.sanitary_registration, r.manufacturer_name, r.distributor_name, r.registration_status
      FROM farmacia.catalog_products p
      LEFT JOIN LATERAL (
        SELECT r.*
        FROM farmacia.catalog_product_registrations r
        WHERE r.product_id = p.id OR (r.sanitary_registration = p.sanitary_registration)
        ORDER BY CASE WHEN r.registration_status = 'VIGENTE' THEN 0 ELSE 1 END, r.imported_at DESC
        LIMIT 1
      ) r ON TRUE
      LIMIT 8`
    );
    console.log("\nMUESTRA:");
    for (const row of sample.rows) {
      console.log(`${row.product_name} | reg=${row.sanitary_registration} | fab=${row.manufacturer_name ?? "-"} | dist=${row.distributor_name ?? "-"}`);
    }
  } finally {
    await pool.end();
  }
}

void main();
