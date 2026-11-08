
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { db } from "@/src/lib/db";
import { hasPermission, authorize } from "@/src/lib/auth/permissions";

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

const receiptSchema = z.object({
  action: z.literal("receipt"),
  branchId: z.string().uuid(),
  productId: z.string().uuid(),
  lotNumber: z.string().trim().min(1).max(120),
  expirationDate: z
    .string()
    .refine(validCalendarDate, "La fecha de vencimiento no es válida."),
  quantity: z.coerce.number().positive().max(1000000),
  unitCost: z.coerce.number().nonnegative().max(100000000).optional(),
  reason: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});

const adjustmentSchema = z.object({
  action: z.literal("adjustment"),
  branchId: z.string().uuid(),
  productId: z.string().uuid(),
  lotId: z.string().uuid(),
  direction: z.enum(["in", "out"]),
  quantity: z.coerce.number().positive().max(1000000),
  reason: z.string().trim().min(5).max(500),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});

const operationSchema = z.discriminatedUnion("action", [
  receiptSchema,
  adjustmentSchema,
]);

function errorResponse(message: string, status: number) {
  return NextResponse.json(
    { success: false, error: message },
    { status },
  );
}

export async function GET(request: NextRequest) {
  try {
    const branchId = request.nextUrl.searchParams.get("branchId");
    const search = request.nextUrl.searchParams.get("search")?.trim() ?? "";

    if (!branchId || !z.string().uuid().safeParse(branchId).success) {
      return errorResponse("Debes indicar una sucursal válida.", 400);
    }

    const access = await authorize("inventory.view");

    if (!access.authorized) {
      return errorResponse(
        "No tienes autorización para consultar inventario.",
        access.reason === "unauthenticated" ? 401 : 403,
      );
    }

    if (!hasPermission(access.session, "inventory.view", branchId)) {
      return errorResponse(
        "No tienes acceso al inventario de esta sucursal.",
        403,
      );
    }

    const branch = await db.query(
      `SELECT id, name
       FROM farmacia.branches
       WHERE id = $1 AND is_active = TRUE`,
      [branchId],
    );

    if (branch.rows.length === 0) {
      return errorResponse("La sucursal no existe o está inactiva.", 404);
    }

    const result = await db.query(
      `SELECT
         s.branch_id,
         s.product_id,
         p.product_name,
         p.brand_name,
         p.sanitary_registration,
         p.dosage_form,
         p.strength,
         p.presentation,
         p.sale_unit,
         s.quantity_on_hand,
         s.quantity_reserved,
         s.quantity_on_hand - s.quantity_reserved AS quantity_available,
         s.minimum_stock,
         s.maximum_stock,
         s.reorder_point,
         s.updated_at,
         CASE
           WHEN s.quantity_on_hand - s.quantity_reserved <= 0
             THEN 'out_of_stock'
           WHEN s.reorder_point IS NOT NULL
             AND s.quantity_on_hand - s.quantity_reserved <= s.reorder_point
             THEN 'reorder'
           WHEN s.minimum_stock IS NOT NULL
             AND s.quantity_on_hand - s.quantity_reserved <= s.minimum_stock
             THEN 'low_stock'
           ELSE 'normal'
         END AS stock_status
       FROM farmacia.inventory_stock s
       INNER JOIN farmacia.catalog_products p
         ON p.id = s.product_id
       WHERE s.branch_id = $1
         AND (
           $2 = ''
           OR p.product_name ILIKE '%' || $2 || '%'
           OR COALESCE(p.brand_name, '') ILIKE '%' || $2 || '%'
           OR COALESCE(p.sanitary_registration, '') ILIKE '%' || $2 || '%'
           OR COALESCE(p.barcode, '') ILIKE '%' || $2 || '%'
         )
       ORDER BY p.product_name
       LIMIT 500`,
      [branchId, search],
    );

    return NextResponse.json({
      success: true,
      branch: branch.rows[0],
      total: result.rows.length,
      stock: result.rows,
    });
  } catch (error) {
    console.error("Error consultando inventario:", error);
    return errorResponse("No fue posible consultar el inventario.", 500);
  }
}

export async function POST(request: NextRequest) {
  let client;

  try {
    const body: unknown = await request.json().catch(() => null);
    const validation = operationSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Los datos enviados no son válidos.",
          details: validation.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const data = validation.data;

    const permission =
      data.action === "receipt"
        ? "inventory.manage"
        : "inventory.adjust";

    const access = await authorize(permission);

    if (!access.authorized) {
      return errorResponse(
        "No tienes autorización para realizar esta operación.",
        access.reason === "unauthenticated" ? 401 : 403,
      );
    }

    if (!hasPermission(access.session, permission, data.branchId)) {
      return errorResponse(
        "No tienes permisos para operar en esta sucursal.",
        403,
      );
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
      return errorResponse("La sucursal no existe o está inactiva.", 404);
    }

    const productResult = await client.query(
      `SELECT id, product_name, verification_status, is_active
       FROM farmacia.catalog_products
       WHERE id = $1
       FOR UPDATE`,
      [data.productId],
    );

    if (productResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return errorResponse("El producto no existe en el catálogo.", 404);
    }

    if (data.idempotencyKey) {
      const duplicate = await client.query(
        `SELECT id
         FROM farmacia.inventory_movements
         WHERE idempotency_key = $1`,
        [data.idempotencyKey],
      );

      if (duplicate.rows.length > 0) {
        await client.query("ROLLBACK");
        return errorResponse("Esta operación ya fue registrada.", 409);
      }
    }

    let lotId: string;
    let movementType: string;
    let delta: number;
    let unitCost: number | null = null;
    let reason: string;

    if (data.action === "receipt") {
      // La fecha debe ser válida y no puede estar vencida.
      const expirationCheck = await client.query(
        `SELECT $1::date < CURRENT_DATE AS expired`,
        [data.expirationDate],
      );

      if (expirationCheck.rows[0].expired) {
        await client.query("ROLLBACK");
        return errorResponse(
          "No puedes recibir mercancía con fecha de vencimiento pasada.",
          400,
        );
      }

      const lotResult = await client.query(
        `INSERT INTO farmacia.inventory_lots (
           branch_id,
           product_id,
           lot_number,
           expiration_date,
           quantity_received,
           quantity_remaining,
           unit_cost,
           created_by
         )
         VALUES ($1, $2, $3, $4, $5, $5, $6, $7)
         ON CONFLICT (branch_id, product_id, lot_number)
         WHERE lot_number IS NOT NULL
         DO UPDATE SET
           quantity_received =
             farmacia.inventory_lots.quantity_received
             + EXCLUDED.quantity_received,
           quantity_remaining =
             farmacia.inventory_lots.quantity_remaining
             + EXCLUDED.quantity_remaining,
           unit_cost = COALESCE(
             EXCLUDED.unit_cost,
             farmacia.inventory_lots.unit_cost
           )
         WHERE farmacia.inventory_lots.expiration_date
           IS NOT DISTINCT FROM EXCLUDED.expiration_date
           AND farmacia.inventory_lots.status = 'available'
           AND farmacia.inventory_lots.expiration_date >= CURRENT_DATE
         RETURNING id`,
        [
          data.branchId,
          data.productId,
          data.lotNumber,
          data.expirationDate,
          data.quantity,
          data.unitCost ?? null,
          access.session.user.id,
        ],
      );

      if (lotResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return errorResponse(
          "El lote ya existe con otro vencimiento, está vencido o está bloqueado. Revisa el lote antes de recibirlo.",
          409,
        );
      }

      lotId = lotResult.rows[0].id;
      movementType = "purchase_receipt";
      delta = data.quantity;
      unitCost = data.unitCost ?? null;
      reason = data.reason || "Recepción de mercancía";
    } else {
      // Bloqueamos primero la existencia agregada para evitar
      // ajustes de salida sobre inventarios inexistentes.
      const stockLock = await client.query(
        `SELECT quantity_on_hand, quantity_reserved
         FROM farmacia.inventory_stock
         WHERE branch_id = $1 AND product_id = $2
         FOR UPDATE`,
        [data.branchId, data.productId],
      );

      if (stockLock.rows.length === 0) {
        await client.query("ROLLBACK");
        return errorResponse(
          "Este producto todavía no tiene existencias registradas. Registra primero una recepción.",
          409,
        );
      }

      const lotResult = await client.query(
        `SELECT
           id,
           quantity_remaining,
           status,
           expiration_date
         FROM farmacia.inventory_lots
         WHERE id = $1
           AND branch_id = $2
           AND product_id = $3
         FOR UPDATE`,
        [data.lotId, data.branchId, data.productId],
      );

      if (lotResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return errorResponse(
          "El lote no existe para este producto y sucursal.",
          404,
        );
      }

      const lot = lotResult.rows[0];
      const stock = stockLock.rows[0];

      if (lot.status !== "available") {
        await client.query("ROLLBACK");
        return errorResponse(
          "No se puede ajustar un lote bloqueado, vencido o agotado.",
          409,
        );
      }

      if (new Date(lot.expiration_date).getTime() <
          new Date(new Date().toISOString().slice(0, 10)).getTime()) {
        await client.query("ROLLBACK");
        return errorResponse(
          "No se puede ajustar un lote cuya fecha de vencimiento ya pasó.",
          409,
        );
      }

      delta = data.direction === "in"
        ? data.quantity
        : -data.quantity;

      const newQuantity = Number(stock.quantity_on_hand) + delta;

      if (newQuantity < Number(stock.quantity_reserved)) {
        await client.query("ROLLBACK");
        return errorResponse(
          "El ajuste dejaría el inventario por debajo de las unidades reservadas.",
          409,
        );
      }

      if (
        data.direction === "out" &&
        Number(lot.quantity_remaining) < data.quantity
      ) {
        await client.query("ROLLBACK");
        return errorResponse(
          "El lote no tiene suficientes unidades para este ajuste.",
          409,
        );
      }

      lotId = lot.id;
      movementType = data.direction === "in"
        ? "adjustment_in"
        : "adjustment_out";
      reason = data.reason;

      // Un ajuste no es una recepción de proveedor.
      // Por eso no modificamos quantity_received.
      await client.query(
        `UPDATE farmacia.inventory_lots
         SET
           quantity_remaining = quantity_remaining + $2,
           status = CASE
             WHEN quantity_remaining + $2 = 0 THEN 'depleted'
             ELSE 'available'
           END
         WHERE id = $1`,
        [lotId, delta],
      );
    }

    const stockResult = await client.query(
      `INSERT INTO farmacia.inventory_stock (
         branch_id,
         product_id,
         quantity_on_hand
       )
       VALUES ($1, $2, $3)
       ON CONFLICT (branch_id, product_id)
       DO UPDATE SET
         quantity_on_hand =
           farmacia.inventory_stock.quantity_on_hand
           + EXCLUDED.quantity_on_hand,
         updated_at = NOW()
       WHERE farmacia.inventory_stock.quantity_on_hand
           + EXCLUDED.quantity_on_hand
         >= farmacia.inventory_stock.quantity_reserved
       RETURNING quantity_on_hand, quantity_reserved`,
      [data.branchId, data.productId, delta],
    );

    if (stockResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return errorResponse(
        "El ajuste dejaría el inventario por debajo de las unidades reservadas.",
        409,
      );
    }

    const movementResult = await client.query(
      `INSERT INTO farmacia.inventory_movements (
         branch_id,
         product_id,
         lot_id,
         movement_type,
         quantity_delta,
         unit_cost,
         idempotency_key,
         reason,
         created_by
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, movement_type, quantity_delta, created_at`,
      [
        data.branchId,
        data.productId,
        lotId,
        movementType,
        delta,
        unitCost,
        data.idempotencyKey ?? null,
        reason,
        access.session.user.id,
      ],
    );

    const movement = movementResult.rows[0];
    const stock = stockResult.rows[0];

    await client.query(
      `INSERT INTO farmacia.audit_logs (
         actor_user_id,
         branch_id,
         action,
         entity,
         entity_id,
         new_values
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        access.session.user.id,
        data.branchId,
        data.action,
        "inventory_movement",
        movement.id,
        JSON.stringify({
          productId: data.productId,
          lotId,
          movementType,
          quantityDelta: delta,
          quantityOnHand: stock.quantity_on_hand,
          reason,
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
        message:
          data.action === "receipt"
            ? "Mercancía recibida correctamente."
            : "Ajuste de inventario registrado correctamente.",
        movement,
        stock,
      },
      { status: 201 },
    );
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }

    const databaseError = error as { code?: string };

    if (databaseError.code === "23505") {
      return errorResponse("La operación ya fue registrada.", 409);
    }

    console.error("Error registrando movimiento de inventario:", error);
    return errorResponse(
      "No fue posible registrar el movimiento.",
      500,
    );
  } finally {
    client?.release();
  }
}
