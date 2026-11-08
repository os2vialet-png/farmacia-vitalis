/** Diagnóstico: cobertura de marca/fabricante, verificación y registro sanitario en el catálogo. */
import { Pool } from "pg";

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const stats = await pool.query<Record<string, string | number>>(`
      SELECT
        (SELECT COUNT(*)::int FROM farmacia.catalog_products WHERE is_active) AS activos,
        (SELECT COUNT(*)::int FROM farmacia.catalog_products WHERE is_active AND manufacturer_id IS NULL) AS sin_marca,
        (SELECT COUNT(*)::int FROM farmacia.catalog_products WHERE is_active AND manufacturer_id IS NOT NULL) AS con_marca,
        (SELECT COUNT(*)::int FROM farmacia.laboratories) AS laboratorios,
        (SELECT COUNT(DISTINCT manufacturer_id)::int FROM farmacia.catalog_products WHERE manufacturer_id IS NOT NULL) AS labs_en_uso,
        (SELECT COUNT(*)::int FROM farmacia.catalog_products WHERE is_active AND sanitary_registration IS NOT NULL AND sanitary_registration <> '') AS con_registro,
        (SELECT COUNT(*)::int FROM farmacia.catalog_products WHERE is_active AND barcode IS NOT NULL AND barcode <> '') AS con_barcode,
        (SELECT COUNT(*)::int FROM farmacia.catalog_products WHERE verification_status = 'verified') AS verificados,
        (SELECT COUNT(*)::int FROM farmacia.catalog_products WHERE is_active AND verification_status = 'pending') AS pendientes
    `);
    console.log("STATS:", JSON.stringify(stats.rows[0], null, 2));

    const badge = await pool.query<Record<string, string | number>>(
      `SELECT verification_status, COUNT(*)::int AS n FROM farmacia.catalog_products GROUP BY verification_status`,
    );
    console.log("\nVERIFICATION: " + JSON.stringify(badge.rows));

    const forms = await pool.query<Record<string, string | number>>(
      `SELECT dosage_form, COUNT(*)::int AS n
      FROM farmacia.catalog_products
      WHERE is_active
      GROUP BY dosage_form
      ORDER BY n DESC
      LIMIT 15
    `);
    console.log("\nFORMAS TOP:");
    for (const row of forms.rows) console.log(`${row.dosage_form ?? "(sin forma)"}: ${row.n}`);
  } finally {
    await pool.end();
  }
}

void main();
