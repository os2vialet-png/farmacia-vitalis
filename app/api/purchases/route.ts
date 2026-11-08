import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { db } from "@/src/lib/db";
import { authorize, hasPermission } from "@/src/lib/auth/permissions";


const validCalendarDate = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const purchaseSchema = z.object({
  branchId: z.string().uuid(),
  supplierId: z.string().uuid(),
  expectedDate: z.string().nullable().optional().refine(
    value => !value || validCalendarDate(value),
    "La fecha estimada no es válida.",
  ),
  taxAmount: z.coerce.number().min(0).max(100000000),
  notes: z.string().trim().max(3000).optional().default(""),
  items: z.array(
    z.object({
      productId: z.string().uuid(),
      quantity: z.coerce.number().int().positive().max(1000000),
      unitCost: z.coerce.number().min(0).max(100000000),
    }),
  ).min(1).max(500),
});

function error(message: string, status: number) {
  return NextResponse.json(
    { success: false, error: message },
    { status },
  );
}

export async function GET(request: NextRequest) {
  try {
    const access = await authorize("purchases.view");

    if (!access.authorized) {
      return error(
        "No tienes autorización para consultar las compras.",
        access.reason === "unauthenticated" ? 401 : 403,
      );
    }

    const branchId = request.nextUrl.searchParams.get("branchId");
    const productSearch =
      request.nextUrl.searchParams.get("products")?.trim() ?? "";

    const branchResult = await db.query(
      `SELECT id, code, name
       FROM farmacia.branches
       WHERE is_active = TRUE
       ORDER BY name`,
    );

    const branches = branchResult.rows.filter(
      branch => hasPermission(access.session, "purchases.view", branch.id),
    );

    if (branchId) {
      if (!z.string().uuid().safeParse(branchId).success) {
        return error("La sucursal indicada no es válida.", 400);
      }

      if (!hasPermission(access.session, "purchases.view", branchId)) {
        return error("No tienes acceso a las compras de esta sucursal.", 403);
      }
    }

    const supplierResult = await db.query(
      `SELECT id, name, commercial_name, tax_id
       FROM farmacia.suppliers
       WHERE is_active = TRUE
       ORDER BY name
       LIMIT 500`,
    );

    if (productSearch.length >= 2) {
      const productResult = await db.query(
        `SELECT
           id,
           product_name,
           brand_name,
           presentation,
           sale_unit,
           verification_status,
           is_active
         FROM farmacia.catalog_products
         WHERE (
           product_name ILIKE '%' || $1 || '%'
           OR COALESCE(brand_name, '') ILIKE '%' || $1 || '%'
           OR COALESCE(sanitary_registration, '') ILIKE '%' || $1 || '%'
           OR COALESCE(barcode, '') ILIKE '%' || $1 || '%'
         )
         ORDER BY
           is_active DESC,
           product_name
         LIMIT 50`,
        [productSearch],
      );

      return NextResponse.json({
        success: true,
        products: productResult.rows,
      });
    }

    let orders: Record<string, unknown>[] = [];

    if (branchId) {
      const orderResult = await db.query(
        `SELECT
           po.id,
           po.order_number,
           po.status,
           po.order_date,
           po.expected_date,
           po.subtotal,
           po.tax_amount,
           po.total_amount,
           s.name AS supplier_name,
           COUNT(poi.id)::int AS product_lines,
           COALESCE(SUM(poi.quantity_ordered), 0)::int AS units_ordered,
           COALESCE(SUM(poi.quantity_received), 0)::int AS units_received
         FROM farmacia.purchase_orders po
         INNER JOIN farmacia.suppliers s
           ON s.id = po.supplier_id
         LEFT JOIN farmacia.purchase_order_items poi
           ON poi.purchase_order_id = po.id
         WHERE po.branch_id = $1
         GROUP BY po.id, s.name
         ORDER BY po.created_at DESC
         LIMIT 300`,
        [branchId],
      );

      orders = orderResult.rows;
    }

    return NextResponse.json({
      success: true,
      branches,
      suppliers: supplierResult.rows,
      orders,
    });
  } catch (e) {
    console.error("GET purchases:", e);
    return error("No fue posible consultar las compras.", 500);
  }
}

export async function POST(request: NextRequest) {
  let client;

  try {
    const access = await authorize("purchases.create");

    if (!access.authorized) {
      return error(
        "No tienes autorización para crear órdenes de compra.",
        access.reason === "unauthenticated" ? 401 : 403,
      );
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = purchaseSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Revisa los datos de la orden de compra.",
          details: parsed.error.issues.map(issue => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const data = parsed.data;

    if (!hasPermission(access.session, "purchases.create", data.branchId)) {
      return error(
        "No tienes permisos para crear compras en esta sucursal.",
        403,
      );
    }

    const productIds = data.items.map(item => item.productId);

    if (new Set(productIds).size !== productIds.length) {
      return error(
        "Hay productos duplicados en la orden. Cada producto debe aparecer una sola vez.",
        400,
      );
    }

    const subtotal = data.items.reduce(
      (sum, item) => sum + item.quantity * item.unitCost,
      0,
    );

    if (!Number.isFinite(subtotal) || !Number.isFinite(subtotal + data.taxAmount)) {
      return error("El total de la orden no es válido.", 400);
    }

    client = await db.connect();
    await client.query("BEGIN");

    const branchResult = await client.query(
      `SELECT id
       FROM farmacia.branches
       WHERE id = $1 AND is_active = TRUE
       FOR SHARE`,
      [data.branchId],
    );

    if (branchResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return error("La sucursal no existe o está inactiva.", 404);
    }

    const supplierResult = await client.query(
      `SELECT id
       FROM farmacia.suppliers
       WHERE id = $1 AND is_active = TRUE
       FOR SHARE`,
      [data.supplierId],
    );

    if (supplierResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return error("El suplidor no existe o está inactivo.", 404);
    }

    const productsResult = await client.query(
      `SELECT id, product_name, is_active
       FROM farmacia.catalog_products
       WHERE id = ANY($1::uuid[])
       FOR SHARE`,
      [productIds],
    );

    if (productsResult.rows.length !== productIds.length) {
      await client.query("ROLLBACK");
      return error(
        "Uno o más productos no existen en el catálogo.",
        400,
      );
    }

    const inactiveProducts = productsResult.rows.filter(
      product => !product.is_active,
    );

    if (inactiveProducts.length > 0) {
      await client.query("ROLLBACK");
      return error(
        "La orden contiene productos inactivos. Revisa el catálogo antes de continuar.",
        400,
      );
    }

    const orderNumber =
      `OC-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 8).toUpperCase()}`;

    const orderResult = await client.query(
      `INSERT INTO farmacia.purchase_orders (
         branch_id,
         supplier_id,
         order_number,
         status,
         order_date,
         expected_date,
         currency,
         subtotal,
         tax_amount,
         total_amount,
         notes,
         created_by
       )
       VALUES (
         $1, $2, $3, 'draft', CURRENT_DATE,
         $4, 'DOP', $5, $6, $7, $8, $9
       )
       RETURNING
         id,
         order_number,
         status,
         subtotal,
         tax_amount,
         total_amount`,
      [
        data.branchId,
        data.supplierId,
        orderNumber,
        data.expectedDate || null,
        subtotal,
        data.taxAmount,
        subtotal + data.taxAmount,
        data.notes || null,
        access.session.user.id,
      ],
    );

    const order = orderResult.rows[0];

    for (const item of data.items) {
      const lineTotal = item.quantity * item.unitCost;

      await client.query(
        `INSERT INTO farmacia.purchase_order_items (
           purchase_order_id,
           product_id,
           quantity_ordered,
           quantity_received,
           unit_cost,
           line_total
         )
         VALUES ($1, $2, $3, 0, $4, $5)`,
        [
          order.id,
          item.productId,
          item.quantity,
          item.unitCost,
          lineTotal,
        ],
      );
    }

    await client.query(
      `INSERT INTO farmacia.audit_logs (
         actor_user_id,
         branch_id,
         action,
         entity,
         entity_id,
         new_values
       )
       VALUES ($1, $2, 'purchase.create', 'purchase_order', $3, $4)`,
      [
        access.session.user.id,
        data.branchId,
        order.id,
        JSON.stringify({
          orderNumber: order.order_number,
          supplierId: data.supplierId,
          productLines: data.items.length,
          subtotal,
          taxAmount: data.taxAmount,
          totalAmount: subtotal + data.taxAmount,
          status: "draft",
        }),
      ],
    );

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    return NextResponse.json(
      {
        success: true,
        message: "Orden de compra creada correctamente.",
        order,
      },
      { status: 201 },
    );
  } catch (e) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }

    const dbError = e as { code?: string };
    if (dbError.code === "23505") {
      return error("Ya existe un registro con esos datos únicos.", 409);
    }

    console.error("POST purchases:", e);
    return error("No fue posible crear la orden de compra.", 500);
  } finally {
    client?.release();
  }
}