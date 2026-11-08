import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { canOperateBranch } from "@/src/lib/access";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { BusinessError, isBusinessError } from "@/src/lib/errors";
import { allocateFifo, sellableQuantity } from "@/src/lib/pos-math";
import { lockTransfer, loadTransferDetail, readTransferHead } from "@/src/lib/transfers";

type Context = { params: Promise<{ id: string }> };

/**
 * Despacha la mercancía aprobada: descuenta del inventario de origen por lote (FIFO por vencimiento),
 * registra qué lote salió y crea movimientos de salida. Todo en una transacción.
 */
export async function POST(request: NextRequest, context: Context) {
  let client;

  try {
    const access = await authorize("transfers.dispatch");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de transferencia inválido.", 400);
    }

    const head = await readTransferHead(id);
    if (!head) return jsonError("La transferencia no existe.", 404);

    if (!(await canOperateBranch(access.session, "transfers.dispatch", head.origin_branch_id))) {
      return jsonError("Solo la sucursal origen puede despachar esta transferencia.", 403);
    }

    const session = access.session;

    client = await db.connect();
    await client.query("BEGIN");

    const locked = await lockTransfer(client, id);
    if (!locked) throw new BusinessError("La transferencia no existe.", 404);
    if (locked.status !== "approved") {
      throw new BusinessError(`La transferencia está en estado ${locked.status} y no se puede despachar.`, 409);
    }

    const items = await client.query<{
      id: string;
      product_id: string;
      product_name: string;
      quantity_approved: number;
    }>(
      `SELECT ti.id, ti.product_id, p.product_name, ti.quantity_approved
       FROM farmacia.transfer_items ti
       INNER JOIN farmacia.catalog_products p ON p.id = ti.product_id
       WHERE ti.transfer_id = $1 AND ti.quantity_approved > 0
       ORDER BY ti.id
       FOR UPDATE OF ti`,
      [id],
    );

    if (items.rows.length === 0) {
      throw new BusinessError("No hay mercancía aprobada para despachar.", 409);
    }

    const origin = locked.origin_branch_id;
    let totalUnits = 0;

    for (const item of items.rows) {
      const quantity = Number(item.quantity_approved);

      const stock = await client.query<{ quantity_on_hand: string; quantity_reserved: string }>(
        `SELECT quantity_on_hand, quantity_reserved
         FROM farmacia.inventory_stock
         WHERE branch_id = $1 AND product_id = $2
         FOR UPDATE`,
        [origin, item.product_id],
      );

      const lots = await client.query<{
        id: string;
        lot_number: string | null;
        expiration_date: string;
        quantity_remaining: string;
        unit_cost: string | null;
      }>(
        `SELECT id, lot_number, to_char(expiration_date, 'YYYY-MM-DD') AS expiration_date,
                quantity_remaining, unit_cost
         FROM farmacia.inventory_lots
         WHERE branch_id = $1
           AND product_id = $2
           AND status = 'available'
           AND quantity_remaining > 0
           AND expiration_date IS NOT NULL
           AND expiration_date >= CURRENT_DATE
         ORDER BY expiration_date ASC, received_at ASC
         FOR UPDATE`,
        [origin, item.product_id],
      );

      const lotsRemaining = lots.rows.reduce((sum, lot) => sum + Number(lot.quantity_remaining), 0);
      const available = stock.rows[0]
        ? sellableQuantity(Number(stock.rows[0].quantity_on_hand), Number(stock.rows[0].quantity_reserved), lotsRemaining)
        : 0;

      if (quantity > available) {
        throw new BusinessError(
          `Inventario insuficiente en origen para ${item.product_name}. Disponible: ${available}.`,
          409,
        );
      }

      const allocations = allocateFifo(
        lots.rows.map((lot) => ({
          lotId: lot.id,
          remaining: Number(lot.quantity_remaining),
          unitCost: lot.unit_cost === null ? 0 : Number(lot.unit_cost),
          expirationDate: lot.expiration_date,
        })),
        quantity,
      );

      if (!allocations) {
        throw new BusinessError(`Inventario insuficiente en origen para ${item.product_name}.`, 409);
      }

      for (const allocation of allocations) {
        const lot = lots.rows.find((row) => row.id === allocation.lotId)!;

        const tilResult = await client.query<{ id: string }>(
          `INSERT INTO farmacia.transfer_item_lots
             (transfer_item_id, origin_lot_id, lot_number, expiration_date, unit_cost, quantity_dispatched)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [item.id, lot.id, lot.lot_number, lot.expiration_date, allocation.unitCost.toFixed(4), allocation.quantity],
        );

        await client.query(
          `UPDATE farmacia.inventory_lots
           SET quantity_remaining = quantity_remaining - $2,
               status = CASE WHEN quantity_remaining - $2 = 0 THEN 'depleted' ELSE status END
           WHERE id = $1`,
          [lot.id, allocation.quantity],
        );

        await client.query(
          `INSERT INTO farmacia.inventory_movements (
             branch_id, product_id, lot_id, movement_type, quantity_delta,
             unit_cost, idempotency_key, reason, reference_type, reference_id, created_by
           )
           VALUES ($1, $2, $3, 'transfer_out', $4, $5, $6, $7, 'transfer', $8, $9)`,
          [
            origin,
            item.product_id,
            lot.id,
            -allocation.quantity,
            allocation.unitCost.toFixed(4),
            `transfer-out:${tilResult.rows[0].id}`,
            `Transferencia ${locked.transfer_number} hacia otra sucursal`,
            id,
            session.user.id,
          ],
        );
      }

      await client.query(
        `UPDATE farmacia.inventory_stock
         SET quantity_on_hand = quantity_on_hand - $3, updated_at = NOW()
         WHERE branch_id = $1 AND product_id = $2`,
        [origin, item.product_id, quantity],
      );

      await client.query(
        `UPDATE farmacia.transfer_items SET quantity_dispatched = $2 WHERE id = $1`,
        [item.id, quantity],
      );

      totalUnits += quantity;
    }

    await client.query(
      `UPDATE farmacia.transfers
       SET status = 'in_transit', dispatched_by = $2, dispatched_at = NOW()
       WHERE id = $1`,
      [id, session.user.id],
    );

    await writeAudit(client, {
      actorUserId: session.user.id,
      branchId: origin,
      action: "transfer.dispatch",
      entity: "transfer",
      entityId: id,
      oldValues: { status: "approved" },
      newValues: { status: "in_transit", totalUnits, lines: items.rows.length },
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
    console.error("Error despachando transferencia:", error);
    return jsonError("No fue posible despachar la transferencia. El inventario no fue modificado.", 500);
  } finally {
    client?.release();
  }
}
