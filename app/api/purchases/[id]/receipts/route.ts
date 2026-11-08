import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { getSession } from "@/src/lib/auth/session";
import { hasPermission } from "@/src/lib/auth/permissions";

const receiptSchema = z.object({
  notes: z.string().max(2000).optional().default(""),
  items: z.array(
    z.object({
      purchaseOrderItemId: z.string().uuid(),
      quantityReceived: z.number().int().positive(),
      lotNumber: z.string().trim().min(1).max(100),
      expirationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      unitCost: z.number().nonnegative().optional(),
    })
  ).min(1),
}).superRefine((data, ctx) => {
  const ids = data.items.map((item) => item.purchaseOrderItemId);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "No repitas el mismo producto dentro de una recepción.",
    });
  }
});

// Errores de negocio seguros para mostrar al usuario (no exponen detalles internos de BD).
class ReceiptBusinessError extends Error {}

function errorResponse(message: string, status: number) {
  return NextResponse.json(
    { success: false, error: message },
    { status }
  );
}

function isValidDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getSession();

  if (!session) {
    return errorResponse("Debes iniciar sesión.", 401);
  }

  const { id: purchaseOrderId } = await context.params;

  if (!z.string().uuid().safeParse(purchaseOrderId).success) {
    return errorResponse("Identificador de compra inválido.", 400);
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return errorResponse("El cuerpo de la solicitud no es válido.", 400);
  }

  const parsed = receiptSchema.safeParse(body);

  if (!parsed.success) {
    return errorResponse(
      parsed.error.issues[0]?.message ?? "Datos de recepción inválidos.",
      400
    );
  }

  for (const item of parsed.data.items) {
    if (!isValidDate(item.expirationDate)) {
      return errorResponse("Hay una fecha de vencimiento inválida.", 400);
    }

    if (item.expirationDate < new Date().toISOString().slice(0, 10)) {
      return errorResponse("No puedes recibir productos vencidos.", 400);
    }
  }

  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const orderResult = await client.query(
      `SELECT id, branch_id, order_number, status
       FROM farmacia.purchase_orders
       WHERE id = $1
       FOR UPDATE`,
      [purchaseOrderId]
    );

    if (orderResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return errorResponse("La orden de compra no existe.", 404);
    }

    const order = orderResult.rows[0];

    if (!hasPermission(session, "inventory.manage", order.branch_id)) {
      await client.query("ROLLBACK");
      return errorResponse(
        "No tienes permiso para recibir mercancía en esta sucursal.",
        403
      );
    }

    if (!["ordered", "partially_received"].includes(order.status)) {
      await client.query("ROLLBACK");
      return errorResponse(
        "La orden debe estar aprobada antes de recibir mercancía.",
        409
      );
    }

    const itemIds = parsed.data.items.map(
      (item) => item.purchaseOrderItemId
    );

    const orderItemsResult = await client.query(
      `SELECT id, product_id, quantity_ordered, quantity_received, unit_cost
       FROM farmacia.purchase_order_items
       WHERE purchase_order_id = $1
         AND id = ANY($2::uuid[])
       FOR UPDATE`,
      [purchaseOrderId, itemIds]
    );

    if (orderItemsResult.rowCount !== itemIds.length) {
      await client.query("ROLLBACK");
      return errorResponse(
        "Uno o más productos no pertenecen a esta orden.",
        400
      );
    }

    const orderItems = new Map(
      orderItemsResult.rows.map((item) => [item.id, item])
    );

    for (const receivedItem of parsed.data.items) {
      const orderItem = orderItems.get(receivedItem.purchaseOrderItemId);

      if (!orderItem) {
        await client.query("ROLLBACK");
        return errorResponse("Producto de la orden no encontrado.", 400);
      }

      const pending =
        Number(orderItem.quantity_ordered) -
        Number(orderItem.quantity_received);

      if (receivedItem.quantityReceived > pending) {
        await client.query("ROLLBACK");
        return errorResponse(
          `La cantidad recibida supera la pendiente para uno de los productos. Pendiente: ${pending}.`,
          400
        );
      }
    }

    const receiptNumber =
      `REC-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8).toUpperCase()}`;

    const receiptResult = await client.query(
      `INSERT INTO farmacia.purchase_receipts
        (purchase_order_id, branch_id, receipt_number, received_by, notes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, receipt_number, received_at`,
      [
        purchaseOrderId,
        order.branch_id,
        receiptNumber,
        session.user.id,
        parsed.data.notes,
      ]
    );

    const receipt = receiptResult.rows[0];

    for (const receivedItem of parsed.data.items) {
      const orderItem = orderItems.get(receivedItem.purchaseOrderItemId)!;
      const unitCost =
        receivedItem.unitCost ?? Number(orderItem.unit_cost);

      const lotResult = await client.query(
        `INSERT INTO farmacia.inventory_lots
          (branch_id, product_id, lot_number, expiration_date,
           quantity_received, quantity_remaining, unit_cost, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $5, $6, 'available', $7)
         ON CONFLICT (branch_id, product_id, lot_number)
           WHERE lot_number IS NOT NULL
         DO UPDATE SET
           quantity_received =
             farmacia.inventory_lots.quantity_received + EXCLUDED.quantity_received,
           quantity_remaining =
             farmacia.inventory_lots.quantity_remaining + EXCLUDED.quantity_remaining
         WHERE farmacia.inventory_lots.expiration_date
                 IS NOT DISTINCT FROM EXCLUDED.expiration_date
           AND farmacia.inventory_lots.status = 'available'
           AND farmacia.inventory_lots.expiration_date >= CURRENT_DATE
         RETURNING id`,
        [
          order.branch_id,
          orderItem.product_id,
          receivedItem.lotNumber,
          receivedItem.expirationDate,
          receivedItem.quantityReceived,
          unitCost,
          session.user.id,
        ]
      );

      if (lotResult.rowCount === 0) {
        throw new ReceiptBusinessError(
          `No se pudo registrar el lote ${receivedItem.lotNumber}. Puede existir con otro vencimiento o estar inactivo.`
        );
      }

      const lotId = lotResult.rows[0].id;

      await client.query(
        `INSERT INTO farmacia.purchase_receipt_items
          (receipt_id, purchase_order_item_id, lot_id, lot_number,
           expiration_date, quantity_received, unit_cost)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          receipt.id,
          receivedItem.purchaseOrderItemId,
          lotId,
          receivedItem.lotNumber,
          receivedItem.expirationDate,
          receivedItem.quantityReceived,
          unitCost,
        ]
      );

      await client.query(
        `UPDATE farmacia.purchase_order_items
         SET quantity_received = quantity_received + $1
         WHERE id = $2`,
        [receivedItem.quantityReceived, receivedItem.purchaseOrderItemId]
      );

      await client.query(
        `INSERT INTO farmacia.inventory_stock
          (branch_id, product_id, quantity_on_hand)
         VALUES ($1, $2, $3)
         ON CONFLICT (branch_id, product_id)
         DO UPDATE SET
           quantity_on_hand =
             farmacia.inventory_stock.quantity_on_hand + EXCLUDED.quantity_on_hand`,
        [order.branch_id, orderItem.product_id, receivedItem.quantityReceived]
      );

      await client.query(
        `INSERT INTO farmacia.inventory_movements
          (branch_id, product_id, lot_id, movement_type, quantity_delta,
           unit_cost, idempotency_key, reason, created_by)
         VALUES ($1, $2, $3, 'purchase_receipt', $4, $5, $6, $7, $8)`,
        [
          order.branch_id,
          orderItem.product_id,
          lotId,
          receivedItem.quantityReceived,
          unitCost,
          randomUUID(),
          `Recepción ${receipt.receipt_number}, orden ${order.order_number}`,
          session.user.id,
        ]
      );
    }

    const completionResult = await client.query(
      `SELECT
         COUNT(*) > 0
         AND BOOL_AND(quantity_received >= quantity_ordered) AS completed
       FROM farmacia.purchase_order_items
       WHERE purchase_order_id = $1`,
      [purchaseOrderId]
    );

    const newStatus = completionResult.rows[0].completed
      ? "received"
      : "partially_received";

    await client.query(
      `UPDATE farmacia.purchase_orders
       SET status = $1, updated_at = NOW()
       WHERE id = $2`,
      [newStatus, purchaseOrderId]
    );

    await client.query(
      `INSERT INTO farmacia.audit_logs
        (actor_user_id, branch_id, action, entity, entity_id, new_values)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        session.user.id,
        order.branch_id,
        "purchase.received",
        "purchase_receipt",
        receipt.id,
        JSON.stringify({
          receiptNumber: receipt.receipt_number,
          purchaseOrderId,
          orderNumber: order.order_number,
          status: newStatus,
          items: parsed.data.items,
        }),
      ]
    );

    await client.query("COMMIT");

    return NextResponse.json({
      success: true,
      message: "Recepción registrada y el inventario actualizado.",
      receipt: {
        id: receipt.id,
        receiptNumber: receipt.receipt_number,
        receivedAt: receipt.received_at,
      },
      orderStatus: newStatus,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);

    if (error instanceof ReceiptBusinessError) {
      return errorResponse(error.message, 409);
    }

    console.error("Error registrando recepción de compra:", error);

    return errorResponse("No se pudo registrar la recepción. Intenta de nuevo.", 500);
  } finally {
    client.release();
  }
}