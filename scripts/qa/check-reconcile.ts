/**
 * Diagnóstico: estado de conciliación de una transferencia QA.
 * Uso: npx tsx --env-file=.env.local scripts/qa/check-reconcile.ts [transferId]
 */
import { Pool } from "pg";

const transferId = process.argv[2] ?? "9c8dff40-11bd-4dca-a8ed-fbac118f6810";

interface HeadRow {
  code: string;
  status: string;
}
interface ItemRow {
  dispatched: number;
  received: number;
  missing: number;
  resolution: string | null;
  reason: string | null;
}
interface MovementRow {
  type: string;
  quantity: number;
  reason: string | null;
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const head = await pool.query<HeadRow>(
      `SELECT transfer_number, status::text AS status FROM farmacia.transfers WHERE id = $1`,
      [transferId],
    );
    console.log("TRANSFERENCIA: " + JSON.stringify(head.rows[0] ?? "no encontrada"));

    const items = await pool.query(
      `SELECT quantity_dispatched::int AS dispatched,
              quantity_received::int AS received, quantity_missing::int AS missing,
              missing_resolution AS resolution,
              missing_resolution_reason AS reason
       FROM farmacia.transfer_items WHERE transfer_id = $1`,
      [transferId],
    );
    console.log("ITEMS:");
    for (const it of items.rows as unknown as ItemRow[]) {
      console.log(
        `desp=${it.dispatched} rec=${it.received} falt=${it.missing}` +
        (it.resolution ? ` resolución=${it.resolution}` : " sin resolución") +
          (it.reason ? ` motivo="${it.reason}"` : ""),
      );
    }

    const movements = await pool.query<MovementRow>(
      `SELECT movement_type::text AS type, reason
       FROM farmacia.inventory_movements
       WHERE reference_type = 'transfer' AND reference_id = $1
       ORDER BY created_at`,
      [transferId],
    );
    console.log("MOVIMIENTOS: " + movements.rows.length);
    for (const mv of movements.rows) {
      console.log(`${mv.type} motivo="${mv.reason ?? ""}"`);
    }

    const audits = await pool.query(
      `SELECT action, created_at, new_values::text AS detail
       FROM farmacia.audit_logs
       WHERE action = 'transfer.reconcile' AND entity = 'transfer' AND entity_id = $1
       ORDER BY created_at DESC`,
      [transferId],
    );
    console.log("AUDIT recientes: " + audits.rows.length);
    for (const row of audits.rows) {
      console.log(`${row.action} @ ${row.created_at}${row.detail ? ` :: ${row.detail.slice(0, 140)}` : ""}`);
    }
  } finally {
    await pool.end();
  }
}

void main();
