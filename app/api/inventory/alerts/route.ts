import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, hasPermission } from "@/src/lib/auth/permissions";

const configSchema = z.object({
  branchId: z.string().uuid(),
  productId: z.string().uuid(),
  minimumStock: z.number().int().min(0),
  maximumStock: z.number().int().min(0),
  reorderPoint: z.number().int().min(0),
}).refine(
  (value) => value.maximumStock >= value.minimumStock,
  { message: "El máximo debe ser igual o superior al mínimo." }
).refine(
  (value) => value.reorderPoint >= value.minimumStock &&
             value.reorderPoint <= value.maximumStock,
  { message: "El punto de reposición debe estar entre el mínimo y el máximo." }
);

export async function GET(request: NextRequest) {
  try {
    const branchId = request.nextUrl.searchParams.get("branchId");

    if (!branchId || !z.string().uuid().safeParse(branchId).success) {
      return NextResponse.json({ error: "Sucursal no válida." }, { status: 400 });
    }

    const access = await authorize("inventory.view");

    if (!access.authorized) {
      return NextResponse.json(
        { error: "No tienes autorización." },
        { status: access.reason === "unauthenticated" ? 401 : 403 }
      );
    }

    if (!hasPermission(access.session, "inventory.view", branchId)) {
      return NextResponse.json({ error: "Sin acceso a esta sucursal." }, { status: 403 });
    }

    const [expirationResult, stockResult] = await Promise.all([
      db.query(
        `SELECT
           l.id,
           l.lot_number,
           l.expiration_date,
           l.quantity_remaining,
           p.id AS product_id,
           p.product_name,
           p.brand_name,
           CASE
             WHEN l.expiration_date < CURRENT_DATE THEN 'expired'
             ELSE 'expiring'
           END AS alert_status,
           (l.expiration_date - CURRENT_DATE) AS days_remaining
         FROM farmacia.inventory_lots l
         INNER JOIN farmacia.catalog_products p ON p.id = l.product_id
         WHERE l.branch_id = $1
           AND l.status = 'available'
           AND l.quantity_remaining > 0
           AND l.expiration_date <= CURRENT_DATE + INTERVAL '30 days'
         ORDER BY l.expiration_date ASC
         LIMIT 200`,
        [branchId]
      ),
      db.query(
        `SELECT
           s.product_id,
           p.product_name,
           p.brand_name,
           p.presentation,
           p.sale_unit,
           s.quantity_on_hand,
           s.quantity_reserved,
           (s.quantity_on_hand - s.quantity_reserved) AS quantity_available,
           s.minimum_stock,
           s.maximum_stock,
           s.reorder_point
         FROM farmacia.inventory_stock s
         INNER JOIN farmacia.catalog_products p ON p.id = s.product_id
         WHERE s.branch_id = $1
           AND (s.quantity_on_hand - s.quantity_reserved) <= s.reorder_point
         ORDER BY (s.quantity_on_hand - s.quantity_reserved) ASC,
                  p.product_name ASC
         LIMIT 200`,
        [branchId]
      )
    ]);

    return NextResponse.json({
      success: true,
      expirationAlerts: expirationResult.rows,
      replenishmentAlerts: stockResult.rows
    });
  } catch (error) {
    console.error("Error consultando alertas de inventario:", error);
    return NextResponse.json(
      { error: "No fue posible consultar las alertas." },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = configSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || "Configuración no válida." },
        { status: 400 }
      );
    }

    const {
      branchId,
      productId,
      minimumStock,
      maximumStock,
      reorderPoint
    } = parsed.data;

    const access = await authorize("inventory.manage");

    if (!access.authorized) {
      return NextResponse.json(
        { error: "No tienes autorización para configurar inventario." },
        { status: access.reason === "unauthenticated" ? 401 : 403 }
      );
    }

    if (!hasPermission(access.session, "inventory.manage", branchId)) {
      return NextResponse.json({ error: "Sin acceso a esta sucursal." }, { status: 403 });
    }

    const result = await db.query(
      `INSERT INTO farmacia.inventory_stock (
         branch_id,
         product_id,
         quantity_on_hand,
         quantity_reserved,
         minimum_stock,
         maximum_stock,
         reorder_point
       )
       SELECT $1, p.id, 0, 0, $3, $4, $5
       FROM farmacia.catalog_products p
       WHERE p.id = $2
       ON CONFLICT (branch_id, product_id)
       DO UPDATE SET
         minimum_stock = EXCLUDED.minimum_stock,
         maximum_stock = EXCLUDED.maximum_stock,
         reorder_point = EXCLUDED.reorder_point
       RETURNING product_id, minimum_stock, maximum_stock, reorder_point`,
      [branchId, productId, minimumStock, maximumStock, reorderPoint]
    );

    if (result.rowCount === 0) {
      return NextResponse.json(
        { error: "El producto no existe en el catálogo." },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: "Parámetros de reposición guardados.",
      settings: result.rows[0]
    });
  } catch (error) {
    console.error("Error guardando parámetros de reposición:", error);
    return NextResponse.json(
      { error: "No fue posible guardar la configuración." },
      { status: 500 }
    );
  }
}