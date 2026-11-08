import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { canOperateBranch } from "@/src/lib/access";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { BusinessError, isBusinessError } from "@/src/lib/errors";
import { loadSaleDetail } from "@/src/lib/sales";

type Context = { params: Promise<{ id: string }> };

const bodySchema = z.object({
  reason: z.string().trim().min(10, "Indica el motivo de la anulación (mínimo 10 caracteres).").max(300),
});

/**
 * Anula una venta completada. Repone al inventario exactamente las unidades
 * de los lotes de donde salieron, en una sola transacción. Una venta solo se puede anular una vez.
 */
export async function POST(request: NextRequest, context: Context) {
  let client;

  try {
    const access = await authorize("sales.cancel");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    const body: unknown = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);

    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de venta inválido.", 400);
    }

    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Motivo no válido.", 400);
    }

    const head = await db.query<{ branch_id: string }>(
      `SELECT branch_id FROM farmacia.sales WHERE id = $1`,
      [id],
    );

    if (head.rows.length === 0) {
      return jsonError("La venta no existe.", 404);
    }

    const session = access.session;
    const branchId = head.rows[0].branch_id;

    if (!(await canOperateBranch(session, "sales.cancel", branchId))) {
      return jsonError("No tienes permiso para anular ventas en esta sucursal.", 403);
    }

    client = await db.connect();
    await client.query("BEGIN");

    const saleResult = await client.query<{ status: string; sale_number: string }>(
      `SELECT status, sale_number FROM farmacia.sales WHERE id = $1 FOR UPDATE`,
      [id],
    );

    if (saleResult.rows[0].status !== "completed") {
      throw new BusinessError("Esta venta ya fue anulada.", 409);
    }

    const saleNumber = saleResult.rows[0].sale_number;

    const lines = await client.query<{
      product_id: string;
      lot_id: string;
      quantity: number;
    }>(
      `SELECT si.product_id, sil.lot_id, sil.quantity
       FROM farmacia.sale_item_lots sil
       INNER JOIN farmacia.sale_items si ON si.id = sil.sale_item_id
       WHERE si.sale_id = $1
       ORDER BY sil.lot_id`,
      [id],
    );

    const perProduct = new Map<string, number>();

    for (const line of lines.rows) {
      const lotResult = await client.query<{ status: string; expired: boolean }>(
        `SELECT status, (expiration_date < CURRENT_DATE) AS expired
         FROM farmacia.inventory_lots
         WHERE id = $1
         FOR UPDATE`,
        [line.lot_id],
      );

      const lot = lotResult.rows[0];

      // Un lote bloqueado manualmente conserva su estado; los demás vuelven a vender o quedan vencidos.
      const nextStatus =
        lot.status === "available" || lot.status === "depleted"
          ? lot.expired ? "expired" : "available"
          : lot.status;

      await client.query(
        `UPDATE farmacia.inventory_lots
         SET quantity_remaining = quantity_remaining + $2, status = $3
         WHERE id = $1`,
        [line.lot_id, line.quantity, nextStatus],
      );

      await client.query(
        `INSERT INTO farmacia.inventory_movements (
           branch_id, product_id, lot_id, movement_type, quantity_delta,
           unit_cost, idempotency_key, reason, reference_type, reference_id, created_by
         )
         SELECT $1, $2, $3, 'sale_return', $4, l.unit_cost, $5, $6, 'sale', $7, $8
         FROM farmacia.inventory_lots l WHERE l.id = $3`,
        [
          branchId,
          line.product_id,
          line.lot_id,
          line.quantity,
          `sale-cancel:${id}:${line.lot_id}`,
          `Anulación de ${saleNumber}: ${parsed.data.reason}`,
          id,
          session.user.id,
        ],
      );

      perProduct.set(line.product_id, (perProduct.get(line.product_id) ?? 0) + line.quantity);
    }

    for (const [productId, quantity] of perProduct) {
      await client.query(
        `UPDATE farmacia.inventory_stock
         SET quantity_on_hand = quantity_on_hand + $3, updated_at = NOW()
         WHERE branch_id = $1 AND product_id = $2`,
        [branchId, productId, quantity],
      );
    }

    await client.query(
      `UPDATE farmacia.sales
       SET status = 'cancelled', cancel_reason = $2, cancelled_by = $3, cancelled_at = NOW()
       WHERE id = $1`,
      [id, parsed.data.reason, session.user.id],
    );

    await writeAudit(client, {
      actorUserId: session.user.id,
      branchId,
      action: "sale.cancel",
      entity: "sale",
      entityId: id,
      oldValues: { status: "completed" },
      newValues: { status: "cancelled", saleNumber, reason: parsed.data.reason },
      ip: clientIp(request),
    });

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    const sale = (await loadSaleDetail(id).catch(() => null)) ?? { id, status: "cancelled" };

    return NextResponse.json({ success: true, message: "Venta anulada e inventario repuesto.", sale });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }

    if (isBusinessError(error)) {
      return jsonError(error.message, error.status);
    }

    console.error("Error anulando venta:", error);
    return jsonError("No fue posible anular la venta. El inventario no fue modificado.", 500);
  } finally {
    client?.release();
  }
}
