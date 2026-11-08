import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, hasPermission } from "@/src/lib/auth/permissions";

function error(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status });
}

type Context = { params: Promise<{ id: string }> };

export async function GET(
  _request: NextRequest,
  context: Context
) {
  try {
    const access = await authorize("purchases.view");

    if (!access.authorized) {
      return error(
        "No tienes autorización para consultar esta compra.",
        access.reason === "unauthenticated" ? 401 : 403
      );
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return error("Identificador de compra inválido.", 400);
    }

    const orderResult = await db.query(
      `SELECT
         po.id,
         po.branch_id,
         po.order_number,
         po.status,
         po.order_date,
         po.expected_date,
         po.subtotal,
         po.tax_amount,
         po.total_amount,
         po.notes,
         s.name AS supplier_name
       FROM farmacia.purchase_orders po
       INNER JOIN farmacia.suppliers s ON s.id = po.supplier_id
       WHERE po.id = $1`,
      [id]
    );

    if (orderResult.rowCount === 0) {
      return error("La orden de compra no existe.", 404);
    }

    const order = orderResult.rows[0];

    if (!hasPermission(access.session, "purchases.view", order.branch_id)) {
      return error("No tienes acceso a esta sucursal.", 403);
    }

    const itemsResult = await db.query(
      `SELECT
         poi.id,
         poi.product_id,
         cp.product_name,
         cp.brand_name,
         cp.presentation,
         cp.sale_unit,
         poi.quantity_ordered,
         poi.quantity_received,
         poi.unit_cost,
         poi.line_total
       FROM farmacia.purchase_order_items poi
       INNER JOIN farmacia.catalog_products cp ON cp.id = poi.product_id
       WHERE poi.purchase_order_id = $1
       ORDER BY cp.product_name`,
      [id]
    );

    return NextResponse.json({
      success: true,
      order,
      items: itemsResult.rows
    });
  } catch (e) {
    console.error("GET purchase detail:", e);
    return error("No fue posible consultar el detalle de la compra.", 500);
  }
}

export async function PATCH(
  request: NextRequest,
  context: Context
) {
  let client;

  try {
    const access = await authorize("purchases.approve");

    if (!access.authorized) {
      return error(
        "No tienes autorización para aprobar compras.",
        access.reason === "unauthenticated" ? 401 : 403
      );
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return error("Identificador de compra inválido.", 400);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = z.object({
      action: z.literal("order")
    }).safeParse(body);

    if (!parsed.success) {
      return error("Acción de compra no válida.", 400);
    }

    client = await db.connect();
    await client.query("BEGIN");

    const orderResult = await client.query(
      `SELECT id, branch_id, order_number, status
       FROM farmacia.purchase_orders
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );

    if (orderResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return error("La orden no existe.", 404);
    }

    const order = orderResult.rows[0];

    if (!hasPermission(access.session, "purchases.approve", order.branch_id)) {
      await client.query("ROLLBACK");
      return error("No tienes permiso para aprobar compras en esta sucursal.", 403);
    }

    if (order.status !== "draft") {
      await client.query("ROLLBACK");
      return error("Solo se pueden aprobar órdenes en borrador.", 409);
    }

    const itemsResult = await client.query(
      `SELECT COUNT(*)::int AS total
       FROM farmacia.purchase_order_items
       WHERE purchase_order_id = $1`,
      [id]
    );

    if (itemsResult.rows[0].total === 0) {
      await client.query("ROLLBACK");
      return error("No se puede aprobar una orden sin productos.", 409);
    }

    await client.query(
      `UPDATE farmacia.purchase_orders
       SET status = 'ordered', updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    await client.query(
      `INSERT INTO farmacia.audit_logs
        (actor_user_id, branch_id, action, entity, entity_id, new_values)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        access.session.user.id,
        order.branch_id,
        "purchase.approve",
        "purchase_order",
        id,
        JSON.stringify({
          orderNumber: order.order_number,
          previousStatus: "draft",
          status: "ordered"
        })
      ]
    );

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    return NextResponse.json({
      success: true,
      message: "Orden aprobada. Ya puedes recibir la mercancía.",
      status: "ordered"
    });
  } catch (e) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }

    console.error("PATCH purchase:", e);
    return error("No fue posible aprobar la orden.", 500);
  } finally {
    client?.release();
  }
}