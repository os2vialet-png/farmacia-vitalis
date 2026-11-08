import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { canOperateBranch } from "@/src/lib/access";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { BusinessError, isBusinessError } from "@/src/lib/errors";
import { lockTransfer, loadTransferDetail, readTransferHead, receiveSchema } from "@/src/lib/transfers";

type Context = { params: Promise<{ id: string }> };

/**
 * Confirma la recepción en destino. Cada lote despachado entra como lote en la sucursal destino
 * (se combina con el existente si tiene el mismo número, producto y vencimiento).
 * Lo que no llega queda registrado como diferencia con motivo obligatorio.
 */
export async function POST(request: NextRequest, context: Context) {
  let client;

  try {
    const access = await authorize("transfers.receive");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de transferencia inválido.", 400);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = receiveSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError("Indica la cantidad recibida de cada producto.", 400);
    }

    const head = await readTransferHead(id);
    if (!head) return jsonError("La transferencia no existe.", 404);

    if (!(await canOperateBranch(access.session, "transfers.receive", head.destination_branch_id))) {
      return jsonError("Solo la sucursal destino puede confirmar la recepción.", 403);
    }

    const session = access.session;

    client = await db.connect();
    await client.query("BEGIN");

    const locked = await lockTransfer(client, id);
    if (!locked) throw new BusinessError("La transferencia no existe.", 404);
    if (locked.status !== "in_transit") {
      throw new BusinessError(`La transferencia está en estado ${locked.status} y no se puede recibir.`, 409);
    }

    const items = await client.query<{
      id: string;
      product_id: string;
      product_name: string;
      quantity_dispatched: number;
    }>(
      `SELECT ti.id, ti.product_id, p.product_name, ti.quantity_dispatched
       FROM farmacia.transfer_items ti
       INNER JOIN farmacia.catalog_products p ON p.id = ti.product_id
       WHERE ti.transfer_id = $1 AND ti.quantity_dispatched > 0
       ORDER BY ti.id
       FOR UPDATE OF ti`,
      [id],
    );

    const received = new Map(parsed.data.items.map((item) => [item.itemId, item]));
    const destination = locked.destination_branch_id;
    let totalMissing = 0;

    for (const item of items.rows) {
      const entry = received.get(item.id);

      if (!entry) {
        throw new BusinessError(`Falta indicar la cantidad recibida de ${item.product_name}.`, 400);
      }

      const dispatched = Number(item.quantity_dispatched);
      if (entry.quantityReceived > dispatched) {
        throw new BusinessError(
          `No puedes recibir más de lo despachado para ${item.product_name} (despachado: ${dispatched}).`,
          400,
        );
      }

      const missing = dispatched - entry.quantityReceived;
      totalMissing += missing;

      if (missing > 0 && (!entry.discrepancyReason || entry.discrepancyReason.length < 10)) {
        throw new BusinessError(
          `Explica la diferencia de ${item.product_name} (faltan ${missing}). Mínimo 10 caracteres.`,
          400,
        );
      }

      // Distribución de lo recibido entre los lotes despachados, en el mismo orden FIFO.
      const lots = await client.query<{
        id: string;
        origin_lot_id: string;
        lot_number: string | null;
        expiration_date: string | null;
        unit_cost: string | null;
        quantity_dispatched: number;
      }>(
        `SELECT id, origin_lot_id, lot_number, to_char(expiration_date, 'YYYY-MM-DD') AS expiration_date,
                unit_cost, quantity_dispatched
         FROM farmacia.transfer_item_lots
         WHERE transfer_item_id = $1
         ORDER BY id`,
        [item.id],
      );

      let remaining = entry.quantityReceived;

      for (const lot of lots.rows) {
        const share = Math.min(Number(lot.quantity_dispatched), remaining);
        remaining -= share;

        if (share === 0) continue;

        const today = await client.query<{ expired: boolean }>(
          `SELECT ($1::date < CURRENT_DATE) AS expired`,
          [lot.expiration_date],
        );

        if (today.rows[0].expired) {
          throw new BusinessError(
            `El lote ${lot.lot_number ?? ""} de ${item.product_name} está vencido y no se puede recibir.`,
            409,
          );
        }

        const upsert = await client.query<{ id: string }>(
          `INSERT INTO farmacia.inventory_lots (
             branch_id, product_id, lot_number, expiration_date,
             quantity_received, quantity_remaining, unit_cost, status, created_by, notes
           )
           VALUES ($1, $2, $3, $4, $5, $5, $6, 'available', $7, $8)
           ON CONFLICT (branch_id, product_id, lot_number)
             WHERE lot_number IS NOT NULL
           DO UPDATE SET
             quantity_received = farmacia.inventory_lots.quantity_received + EXCLUDED.quantity_received,
             quantity_remaining = farmacia.inventory_lots.quantity_remaining + EXCLUDED.quantity_remaining
           WHERE farmacia.inventory_lots.expiration_date IS NOT DISTINCT FROM EXCLUDED.expiration_date
             AND farmacia.inventory_lots.status = 'available'
             AND farmacia.inventory_lots.expiration_date >= CURRENT_DATE
           RETURNING id`,
          [
            destination,
            item.product_id,
            lot.lot_number,
            lot.expiration_date,
            share,
            lot.unit_cost,
            session.user.id,
            `Transferencia ${locked.transfer_number}`,
          ],
        );

        if (upsert.rows.length === 0) {
          throw new BusinessError(
            `El lote ${lot.lot_number ?? ""} ya existe en destino con otro vencimiento o está bloqueado. Revísalo antes de recibir.`,
            409,
          );
        }

        const destinationLotId = upsert.rows[0].id;

        await client.query(
          `UPDATE farmacia.transfer_item_lots
           SET quantity_received = $2, destination_lot_id = $3
           WHERE id = $1`,
          [lot.id, share, destinationLotId],
        );

        await client.query(
          `INSERT INTO farmacia.inventory_stock (branch_id, product_id, quantity_on_hand)
           VALUES ($1, $2, $3)
           ON CONFLICT (branch_id, product_id)
           DO UPDATE SET quantity_on_hand = farmacia.inventory_stock.quantity_on_hand + EXCLUDED.quantity_on_hand,
                         updated_at = NOW()`,
          [destination, item.product_id, share],
        );

        await client.query(
          `INSERT INTO farmacia.inventory_movements (
             branch_id, product_id, lot_id, movement_type, quantity_delta,
             unit_cost, idempotency_key, reason, reference_type, reference_id, created_by
           )
           VALUES ($1, $2, $3, 'transfer_in', $4, $5, $6, $7, 'transfer', $8, $9)`,
          [
            destination,
            item.product_id,
            destinationLotId,
            share,
            lot.unit_cost,
            `transfer-in:${lot.id}`,
            `Recepción de transferencia ${locked.transfer_number}`,
            id,
            session.user.id,
          ],
        );
      }

      await client.query(
        `UPDATE farmacia.transfer_items
         SET quantity_received = $2, quantity_missing = $3, discrepancy_reason = $4
         WHERE id = $1`,
        [item.id, entry.quantityReceived, missing, missing > 0 ? entry.discrepancyReason : null],
      );
    }

    await client.query(
      `UPDATE farmacia.transfers
       SET status = 'received', received_by = $2, received_at = NOW()
       WHERE id = $1`,
      [id, session.user.id],
    );

    await writeAudit(client, {
      actorUserId: session.user.id,
      branchId: destination,
      action: "transfer.receive",
      entity: "transfer",
      entityId: id,
      oldValues: { status: "in_transit" },
      newValues: { status: "received", totalMissing },
      ip: clientIp(request),
    });

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    return NextResponse.json({ success: true, transfer: (await loadTransferDetail(id).catch(() => null)) ?? { id } });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    if (isBusinessError(error)) return jsonError(error.message, error.status);
    console.error("Error recibiendo transferencia:", error);
    return jsonError("No fue posible confirmar la recepción. El inventario no fue modificado.", 500);
  } finally {
    client?.release();
  }
}
