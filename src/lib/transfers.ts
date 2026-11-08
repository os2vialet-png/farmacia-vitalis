import "server-only";

import { z } from "zod";
import type { Queryable } from "@/src/lib/audit";
import { db } from "@/src/lib/db";
import { MISSING_RESOLUTIONS } from "@/src/lib/transfer-format";

export const transferCreateSchema = z.object({
  originBranchId: z.string().uuid(),
  destinationBranchId: z.string().uuid(),
  notes: z.string().trim().max(500).optional(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(1000000),
      }),
    )
    .min(1)
    .max(200),
});

export const approveSchema = z.object({
  items: z
    .array(z.object({ itemId: z.string().uuid(), quantityApproved: z.number().int().min(0).max(1000000) }))
    .min(1),
});

export const receiveSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        quantityReceived: z.number().int().min(0).max(1000000),
        discrepancyReason: z.string().trim().max(500).optional(),
      }),
    )
    .min(1),
});

export const reasonSchema = z.object({
  reason: z.string().trim().min(10, "Indica el motivo (mínimo 10 caracteres).").max(300),
});

/**
 * Conciliación de diferencias de una transferencia ya recibida.
 * - returned: las unidades volvieron al estante de origen (sube el inventario de origen).
 * - found_late: las unidades llegaron tarde a destino (sube el inventario de destino).
 * - written_off: las unidades se dan por perdidas (sin cambio de inventario).
 * En los tres casos se guarda quién, cuándo y el motivo.
 * Las etiquetas compartidas con la interfaz están en src/lib/transfer-format.ts.
 */
export const reconcileSchema = z.object({
  items: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        resolution: z.enum(MISSING_RESOLUTIONS),
        reason: z.string().trim().min(10, "Indica el motivo (mínimo 10 caracteres).").max(300),
      }),
    )
    .min(1)
    .max(50),
});

export type TransferHead = {
  id: string;
  transfer_number: string;
  origin_branch_id: string;
  destination_branch_id: string;
  status: "requested" | "approved" | "in_transit" | "received" | "rejected" | "cancelled";
};

/** Carga y bloquea la transferencia para una transición de estado. */
export async function lockTransfer(executor: Queryable, id: string): Promise<TransferHead | null> {
  const result = (await executor.query(
    `SELECT id, transfer_number, origin_branch_id, destination_branch_id, status
     FROM farmacia.transfers WHERE id = $1 FOR UPDATE`,
    [id],
  )) as { rows: TransferHead[] };

  return result.rows[0] ?? null;
}

/** Consulta sin bloqueo, usada para decidir permisos antes de abrir la transacción. */
export async function readTransferHead(id: string): Promise<TransferHead | null> {
  const result = await db.query<TransferHead>(
    `SELECT id, transfer_number, origin_branch_id, destination_branch_id, status
     FROM farmacia.transfers WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Detalle completo de la transferencia para la API y la interfaz. */
export async function loadTransferDetail(id: string) {
  const head = await db.query(
    `SELECT t.id, t.transfer_number, t.status, t.notes,
            t.origin_branch_id, ob.name AS origin_name,
            t.destination_branch_id, db.name AS destination_name,
            t.requested_at, t.approved_at, t.dispatched_at, t.received_at,
            t.rejected_at, t.rejection_reason, t.cancelled_at, t.cancel_reason,
            TRIM(CONCAT(ru.first_name, ' ', ru.last_name)) AS requested_by_name,
            TRIM(CONCAT(au.first_name, ' ', au.last_name)) AS approved_by_name,
            TRIM(CONCAT(du.first_name, ' ', du.last_name)) AS dispatched_by_name,
            TRIM(CONCAT(eu.first_name, ' ', eu.last_name)) AS received_by_name
     FROM farmacia.transfers t
     INNER JOIN farmacia.branches ob ON ob.id = t.origin_branch_id
     INNER JOIN farmacia.branches db ON db.id = t.destination_branch_id
     INNER JOIN farmacia.users ru ON ru.id = t.requested_by
     LEFT JOIN farmacia.users au ON au.id = t.approved_by
     LEFT JOIN farmacia.users du ON du.id = t.dispatched_by
     LEFT JOIN farmacia.users eu ON eu.id = t.received_by
     WHERE t.id = $1`,
    [id],
  );

  if (head.rows.length === 0) return null;

  const items = await db.query(
    `SELECT ti.id, ti.product_id, p.product_name, p.sale_unit,
            ti.quantity_requested, ti.quantity_approved, ti.quantity_dispatched,
            ti.quantity_received, ti.quantity_missing, ti.discrepancy_reason,
            ti.missing_resolution, ti.missing_resolution_reason,
            TRIM(CONCAT(tu.first_name, ' ', tu.last_name)) AS missing_resolved_by_name
     FROM farmacia.transfer_items ti
     INNER JOIN farmacia.catalog_products p ON p.id = ti.product_id
     LEFT JOIN farmacia.users tu ON tu.id = ti.missing_resolved_by
     WHERE ti.transfer_id = $1
     ORDER BY p.product_name`,
    [id],
  );

  const lots = await db.query(
    `SELECT til.transfer_item_id, til.lot_number,
            to_char(til.expiration_date, 'YYYY-MM-DD') AS expiration_date,
            til.quantity_dispatched, til.quantity_received
     FROM farmacia.transfer_item_lots til
     INNER JOIN farmacia.transfer_items ti ON ti.id = til.transfer_item_id
     WHERE ti.transfer_id = $1
     ORDER BY til.id`,
    [id],
  );

  return { ...head.rows[0], items: items.rows, lots: lots.rows };
}
