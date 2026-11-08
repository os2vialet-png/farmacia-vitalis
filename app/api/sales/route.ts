import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import {
  authorize,
  authorizationMessage,
  authorizationStatus,
  hasPermission,
} from "@/src/lib/auth/permissions";
import { canOperateBranch } from "@/src/lib/access";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { BusinessError, isBusinessError, isUniqueViolation } from "@/src/lib/errors";
import { loadSaleDetail } from "@/src/lib/sales";
import {
  allocateFifo,
  centsToDecimal,
  computeChange,
  computeLine,
  sellableQuantity,
  toCents,
} from "@/src/lib/pos-math";

const TIMEZONE = "America/Santo_Domingo";

const itemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1).max(100000),
  discount: z.number().min(0).max(100000000).optional().default(0),
  discountReason: z.string().trim().max(200).optional(),
});

const paymentSchema = z.object({
  method: z.enum(["cash", "card", "bank_transfer", "other"]),
  amount: z.number().positive().max(100000000),
  reference: z.string().trim().max(100).optional(),
});

const saleSchema = z.object({
  branchId: z.string().uuid(),
  customerId: z.string().uuid().nullable().optional(),
  idempotencyKey: z.string().trim().min(8).max(80),
  items: z.array(itemSchema).min(1).max(200),
  payments: z.array(paymentSchema).min(1).max(10),
  notes: z.string().trim().max(500).optional(),
});

type ProductRow = {
  id: string;
  product_name: string;
  sale_unit: string | null;
  is_active: boolean;
  verification_status: string;
  tax_rate: string | null;
};

/**
 * Confirma una venta. Todo ocurre en una sola transacción:
 * valida producto, precio, existencias y lotes; descuenta inventario FIFO por vencimiento;
 * registra venta, pagos, trazabilidad por lote, movimientos y auditoría.
 * La clave de idempotencia evita registrar dos veces la misma venta (doble clic, reintento de red).
 */
export async function POST(request: NextRequest) {
  let client;
  let retryKey: string | undefined;

  try {
    const access = await authorize("sales.create");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = saleSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError("Revisa los datos de la venta.", 400, {
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const data = parsed.data;
    const session = access.session;
    retryKey = data.idempotencyKey;

    if (!(await canOperateBranch(session, "sales.create", data.branchId))) {
      return jsonError("No tienes permiso para vender en esta sucursal.", 403);
    }

    const hasDiscount = data.items.some((item) => item.discount > 0);

    if (hasDiscount && !hasPermission(session, "sales.discount", data.branchId)) {
      return jsonError("No tienes permiso para aplicar descuentos.", 403);
    }

    const productIds = data.items.map((item) => item.productId);

    if (new Set(productIds).size !== productIds.length) {
      return jsonError("Un producto no puede aparecer dos veces en la misma venta. Ajusta la cantidad.", 400);
    }

    // Operación ya registrada: se devuelve la venta existente sin duplicarla.
    const existing = await db.query<{ id: string; branch_id: string }>(
      `SELECT id, branch_id FROM farmacia.sales WHERE idempotency_key = $1`,
      [data.idempotencyKey],
    );

    if (existing.rows.length > 0) {
      if (existing.rows[0].branch_id !== data.branchId) {
        return jsonError("Esta operación ya fue registrada en otra sucursal.", 409);
      }

      const sale = await loadSaleDetail(existing.rows[0].id);
      return NextResponse.json({ success: true, duplicate: true, sale });
    }

    client = await db.connect();
    await client.query("BEGIN");

    const branchResult = await client.query(
      `SELECT id FROM farmacia.branches WHERE id = $1 AND is_active = TRUE FOR SHARE`,
      [data.branchId],
    );

    if (branchResult.rows.length === 0) {
      throw new BusinessError("La sucursal no existe o está inactiva.", 404);
    }

    if (data.customerId) {
      const customerResult = await client.query(
        `SELECT id FROM farmacia.customers WHERE id = $1 AND is_active = TRUE FOR SHARE`,
        [data.customerId],
      );

      if (customerResult.rows.length === 0) {
        throw new BusinessError("El cliente no existe o está inactivo.", 404);
      }
    }

    // Bloqueo de productos en orden de id para evitar interbloqueos entre ventas concurrentes.
    const productsResult = await client.query<ProductRow>(
      `SELECT id, product_name, sale_unit, is_active, verification_status, tax_rate
       FROM farmacia.catalog_products
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR SHARE`,
      [productIds],
    );

    if (productsResult.rows.length !== productIds.length) {
      throw new BusinessError("Uno o más productos no existen en el catálogo.", 400);
    }

    const products = new Map(productsResult.rows.map((row) => [row.id, row]));

    for (const row of productsResult.rows) {
      if (!row.is_active) {
        throw new BusinessError(`${row.product_name} está inactivo y no se puede vender.`, 409);
      }
      if (row.verification_status !== "verified") {
        throw new BusinessError(`${row.product_name} no está verificado y no se puede vender.`, 409);
      }
      if (!row.sale_unit || row.sale_unit.trim() === "") {
        throw new BusinessError(`${row.product_name} no tiene unidad de venta configurada.`, 409);
      }
    }

    const priceResult = await client.query<{ product_id: string; sale_price: string }>(
      `SELECT DISTINCT ON (product_id) product_id, sale_price
       FROM farmacia.product_branch_prices
       WHERE branch_id = $1
         AND product_id = ANY($2::uuid[])
         AND effective_from <= NOW()
         AND (effective_until IS NULL OR effective_until > NOW())
       ORDER BY product_id, effective_from DESC`,
      [data.branchId, productIds],
    );

    const prices = new Map(priceResult.rows.map((row) => [row.product_id, row.sale_price]));

    type Prepared = {
      productId: string;
      productName: string;
      saleUnit: string;
      quantity: number;
      unitPriceCents: number;
      discountCents: number;
      discountReason: string | null;
      taxRate: number;
      totals: ReturnType<typeof computeLine>;
      allocations: { lotId: string; quantity: number; unitCost: number }[];
    };

    const prepared: Prepared[] = [];

    for (const item of data.items) {
      const product = products.get(item.productId);

      if (!product) {
        throw new BusinessError("Producto no encontrado.", 400);
      }

      const price = prices.get(item.productId);

      if (!price) {
        throw new BusinessError(`${product.product_name} no tiene precio vigente en esta sucursal.`, 409);
      }

      // Bloqueo de existencias y lotes del producto en esta sucursal.
      const stockResult = await client.query<{ quantity_on_hand: string; quantity_reserved: string }>(
        `SELECT quantity_on_hand, quantity_reserved
         FROM farmacia.inventory_stock
         WHERE branch_id = $1 AND product_id = $2
         FOR UPDATE`,
        [data.branchId, item.productId],
      );

      const lotsResult = await client.query<{
        id: string;
        quantity_remaining: string;
        unit_cost: string | null;
        expiration_date: string;
      }>(
        `SELECT id, quantity_remaining, unit_cost, to_char(expiration_date, 'YYYY-MM-DD') AS expiration_date
         FROM farmacia.inventory_lots
         WHERE branch_id = $1
           AND product_id = $2
           AND status = 'available'
           AND quantity_remaining > 0
           AND expiration_date IS NOT NULL
           AND expiration_date >= CURRENT_DATE
         ORDER BY expiration_date ASC, received_at ASC
         FOR UPDATE`,
        [data.branchId, item.productId],
      );

      const stock = stockResult.rows[0];
      const lotsRemaining = lotsResult.rows.reduce((sum, lot) => sum + Number(lot.quantity_remaining), 0);
      const available = stock
        ? sellableQuantity(Number(stock.quantity_on_hand), Number(stock.quantity_reserved), lotsRemaining)
        : 0;

      if (item.quantity > available) {
        throw new BusinessError(
          `Inventario insuficiente para ${product.product_name}. Disponible: ${available} ${product.sale_unit}.`,
          409,
        );
      }

      const allocations = allocateFifo(
        lotsResult.rows.map((lot) => ({
          lotId: lot.id,
          remaining: Number(lot.quantity_remaining),
          unitCost: lot.unit_cost === null ? 0 : Number(lot.unit_cost),
          expirationDate: lot.expiration_date,
        })),
        item.quantity,
      );

      if (!allocations) {
        throw new BusinessError(`Inventario insuficiente para ${product.product_name}.`, 409);
      }

      const taxRate = product.tax_rate === null ? 0 : Number(product.tax_rate);
      const discountCents = toCents(item.discount);
      const totals = computeLine({
        unitPriceCents: toCents(price),
        quantity: item.quantity,
        discountCents,
        taxRate,
      });

      if (!product.sale_unit) {
        throw new BusinessError(`${product.product_name} no tiene unidad de venta configurada.`, 409);
      }

      prepared.push({
        productId: item.productId,
        productName: product.product_name,
        saleUnit: product.sale_unit,
        quantity: item.quantity,
        unitPriceCents: toCents(price),
        discountCents,
        discountReason: item.discountReason ?? null,
        taxRate,
        totals,
        allocations,
      });
    }

    const subtotalCents = prepared.reduce((sum, line) => sum + line.totals.baseCents, 0);
    const discountTotalCents = prepared.reduce((sum, line) => sum + line.totals.discountCents, 0);
    const taxTotalCents = prepared.reduce((sum, line) => sum + line.totals.taxCents, 0);
    const totalCents = prepared.reduce((sum, line) => sum + line.totals.totalCents, 0);

    const paidCents = data.payments.reduce((sum, payment) => sum + toCents(payment.amount), 0);
    const cashCents = data.payments
      .filter((payment) => payment.method === "cash")
      .reduce((sum, payment) => sum + toCents(payment.amount), 0);

    let changeCents: number;
    try {
      changeCents = computeChange(paidCents, totalCents, cashCents);
    } catch (error) {
      throw new BusinessError(error instanceof Error ? error.message : "Pago no válido.", 400);
    }

    const sequence = await client.query<{ day: string; n: string }>(
      `SELECT to_char(NOW() AT TIME ZONE '${TIMEZONE}', 'YYYYMMDD') AS day,
              nextval('farmacia.sale_number_seq') AS n`,
    );
    const saleNumber = `VTA-${sequence.rows[0].day}-${String(sequence.rows[0].n).padStart(6, "0")}`;

    const saleResult = await client.query<{ id: string }>(
      `INSERT INTO farmacia.sales (
         sale_number, branch_id, customer_id, status,
         subtotal, discount_total, tax_total, total,
         amount_paid, change_amount, idempotency_key,
         cashier_id, notes
       )
       VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
        saleNumber,
        data.branchId,
        data.customerId ?? null,
        centsToDecimal(subtotalCents),
        centsToDecimal(discountTotalCents),
        centsToDecimal(taxTotalCents),
        centsToDecimal(totalCents),
        centsToDecimal(paidCents),
        centsToDecimal(changeCents),
        data.idempotencyKey,
        session.user.id,
        data.notes || null,
      ],
    );

    const saleId = saleResult.rows[0].id;

    for (const line of prepared) {
      const unitCost = line.allocations.reduce((sum, allocation) => sum + allocation.unitCost * allocation.quantity, 0) / line.quantity;
      // Costo promedio ponderado por los lotes de donde salió la mercancía.

      const itemResult = await client.query<{ id: string }>(
        `INSERT INTO farmacia.sale_items (
           sale_id, product_id, product_name, sale_unit, quantity,
           unit_price, unit_cost, discount_amount, discount_reason,
           tax_rate, tax_amount, line_total
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          saleId,
          line.productId,
          line.productName,
          line.saleUnit,
          line.quantity,
          centsToDecimal(line.unitPriceCents),
          unitCost.toFixed(4),
          centsToDecimal(line.discountCents),
          line.discountReason,
          line.taxRate.toFixed(4),
          centsToDecimal(line.totals.taxCents),
          centsToDecimal(line.totals.totalCents),
        ],
      );

      const saleItemId = itemResult.rows[0].id;

      for (const allocation of line.allocations) {
        await client.query(
          `INSERT INTO farmacia.sale_item_lots (sale_item_id, lot_id, quantity, unit_cost)
           VALUES ($1, $2, $3, $4)`,
          [saleItemId, allocation.lotId, allocation.quantity, allocation.unitCost.toFixed(4)],
        );

        await client.query(
          `UPDATE farmacia.inventory_lots
           SET quantity_remaining = quantity_remaining - $2,
               status = CASE WHEN quantity_remaining - $2 = 0 THEN 'depleted' ELSE status END
           WHERE id = $1`,
          [allocation.lotId, allocation.quantity],
        );

        await client.query(
          `INSERT INTO farmacia.inventory_movements (
             branch_id, product_id, lot_id, movement_type, quantity_delta,
             unit_cost, idempotency_key, reason, reference_type, reference_id, created_by
           )
           VALUES ($1, $2, $3, 'sale', $4, $5, $6, $7, 'sale', $8, $9)`,
          [
            data.branchId,
            line.productId,
            allocation.lotId,
            -allocation.quantity,
            allocation.unitCost.toFixed(4),
            `sale:${saleId}:${allocation.lotId}`,
            `Venta ${saleNumber}`,
            saleId,
            session.user.id,
          ],
        );
      }

      await client.query(
        `UPDATE farmacia.inventory_stock
         SET quantity_on_hand = quantity_on_hand - $3, updated_at = NOW()
         WHERE branch_id = $1 AND product_id = $2`,
        [data.branchId, line.productId, line.quantity],
      );
    }

    for (const payment of data.payments) {
      await client.query(
        `INSERT INTO farmacia.sale_payments (sale_id, method, amount, reference)
         VALUES ($1, $2, $3, $4)`,
        [saleId, payment.method, centsToDecimal(toCents(payment.amount)), payment.reference || null],
      );
    }

    await writeAudit(client, {
      actorUserId: session.user.id,
      branchId: data.branchId,
      action: "sale.create",
      entity: "sale",
      entityId: saleId,
      newValues: {
        saleNumber,
        totalCents,
        discountTotalCents,
        taxTotalCents,
        items: prepared.map((line) => ({ productId: line.productId, quantity: line.quantity })),
        customerId: data.customerId ?? null,
      },
      ip: clientIp(request),
    });

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    // La venta ya está confirmada: si el detalle no carga, se responde éxito con lo esencial.
    const sale = (await loadSaleDetail(saleId).catch(() => null)) ?? { id: saleId, sale_number: saleNumber };

    return NextResponse.json({ success: true, duplicate: false, sale }, { status: 201 });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }

    if (isBusinessError(error)) {
      return jsonError(error.message, error.status);
    }

    // Dos peticiones con la misma clave llegaron a la vez: la segunda encuentra la venta ya creada.
    if (isUniqueViolation(error)) {
      if (retryKey) {
        const existing = await db.query<{ id: string }>(
          `SELECT id FROM farmacia.sales WHERE idempotency_key = $1`,
          [retryKey],
        );
        if (existing.rows.length > 0) {
          const sale = await loadSaleDetail(existing.rows[0].id);
          return NextResponse.json({ success: true, duplicate: true, sale });
        }
      }
      return jsonError("La venta ya fue registrada. Revisa el historial de ventas.", 409);
    }

    console.error("Error confirmando venta:", error);
    return jsonError("No fue posible confirmar la venta. No se descontó inventario.", 500);
  } finally {
    client?.release();
  }
}

const listSchema = z.object({
  branchId: z.string().uuid(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: z.enum(["completed", "cancelled", "all"]).default("all"),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** Historial de ventas de una sucursal, por rango de fechas (zona horaria de República Dominicana). */
export async function GET(request: NextRequest) {
  try {
    const access = await authorize("sales.view");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const params = listSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));

    if (!params.success) {
      return jsonError("Revisa los filtros del historial.", 400);
    }

    const { branchId, from, to, status, limit } = params.data;

    if (!(await canOperateBranch(access.session, "sales.view", branchId))) {
      return jsonError("No tienes acceso al historial de esta sucursal.", 403);
    }

    const result = await db.query(
      `SELECT
         s.id, s.sale_number, s.status, s.total, s.amount_paid, s.change_amount, s.created_at,
         s.cancelled_at, c.full_name AS customer_name,
         TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS cashier_name,
         (SELECT COUNT(*)::int FROM farmacia.sale_items si WHERE si.sale_id = s.id) AS line_count
       FROM farmacia.sales s
       INNER JOIN farmacia.users u ON u.id = s.cashier_id
       LEFT JOIN farmacia.customers c ON c.id = s.customer_id
       WHERE s.branch_id = $1
         AND ($2::text IS NULL OR s.created_at >= ($2::date)::timestamp AT TIME ZONE '${TIMEZONE}')
         AND ($3::text IS NULL OR s.created_at < (($3::date) + 1)::timestamp AT TIME ZONE '${TIMEZONE}')
         AND ($4 = 'all' OR s.status = $4)
       ORDER BY s.created_at DESC
       LIMIT $5`,
      [branchId, from ?? null, to ?? null, status, limit],
    );

    return NextResponse.json({ success: true, sales: result.rows });
  } catch (error) {
    console.error("Error consultando ventas:", error);
    return jsonError("No fue posible consultar las ventas.", 500);
  }
}
