/** Diagnóstico: estado de laboratorios tras la importación de marcas. */
import { Pool } from "pg";

interface LabRow {
  id: string;
  name: string;
  normalized_name: string;
  products: number;
}
interface AssignCount {
  n: number;
}
interface OrphanCount {
  n: number;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const assigned = await pool.query<AssignCount>(
      `SELECT COUNT(*)::int AS n FROM farmacia.catalog_products WHERE manufacturer_id IS NOT NULL`,
    );
    console.log("productos con marca: " + assigned.rows[0].n);

    const labs = await pool.query<LabRow>(
      `SELECT l.id, l.name, l.normalized_name,
              (SELECT COUNT(*) FROM farmacia.catalog_products p WHERE p.manufacturer_id = l.id)::int AS products
       FROM farmacia.laboratories l
       ORDER BY products DESC, l.name
       LIMIT 12`,
    );
    console.log("laboratorios (muestra):");
    for (const row of labs.rows) {
      console.log(`name=${row.name} | norm=${row.normalized_name} | productos=${row.products}`);
    }

    return;
  } finally {
    await pool.end();
  }
}

void main();
