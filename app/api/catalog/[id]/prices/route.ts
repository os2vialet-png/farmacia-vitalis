import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { canOperateBranch } from "@/src/lib/access";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { priceSchema } from "@/src/lib/catalog";
import { centsToDecimal, toCents } from "@/src/lib/pos-math";

type Context = { params: Promise<{ id: string }> };

/**
 * Define un nuevo precio de venta para el producto en una sucursal.
 * El precio anterior se cierra en el mismo instante, así siempre hay un único precio vigente.
 */
export async function POST(request: NextRequest, context: Context) {
  let client;

  try {
    const access = await authorize("catalog.prices");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de producto inválido.", 400);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = priceSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Precio no válido.", 400);
    }

    const { branchId, salePrice } = parsed.data;

    if (!(await canOperateBranch(access.session, "catalog.prices", branchId))) {
      return jsonError("No tienes permiso para fijar precios en esta sucursal.", 403);
    }

    const priceCents = toCents(salePrice);
    const priceText = centsToDecimal(priceCents);

    client = await db.connect();
    await client.query("BEGIN");

    const product = await client.query(`SELECT id FROM farmacia.catalog_products WHERE id = $1 FOR SHARE`, [id]);
    if (product.rows.length === 0) {
      await client.query("ROLLBACK");
      return jsonError("El producto no existe.", 404);
    }

    const branch = await client.query(`SELECT id FROM farmacia.branches WHERE id = $1 AND is_active = TRUE FOR SHARE`, [branchId]);
    if (branch.rows.length === 0) {
      await client.query("ROLLBACK");
      return jsonError("La sucursal no existe o está inactiva.", 404);
    }

    const previous = await client.query<{ sale_price: string }>(
      `SELECT sale_price FROM farmacia.product_branch_prices
       WHERE product_id = $1 AND branch_id = $2
         AND effective_from <= NOW()
         AND (effective_until IS NULL OR effective_until > NOW())
       FOR UPDATE`,
      [id, branchId],
    );

    await client.query(
      `UPDATE farmacia.product_branch_prices
       SET effective_until = NOW(), updated_at = NOW()
       WHERE product_id = $1 AND branch_id = $2
         AND effective_from <= NOW()
         AND (effective_until IS NULL OR effective_until > NOW())`,
      [id, branchId],
    );

    await client.query(
      `INSERT INTO farmacia.product_branch_prices (product_id, branch_id, sale_price, effective_from)
       VALUES ($1, $2, $3, NOW())`,
      [id, branchId, priceText],
    );

    await writeAudit(client, {
      actorUserId: access.session.user.id,
      branchId,
      action: "catalog.price_change",
      entity: "catalog_product",
      entityId: id,
      oldValues: { salePrice: previous.rows[0]?.sale_price ?? null },
      newValues: { salePrice: priceText },
      ip: clientIp(request),
    });

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    return NextResponse.json({ success: true, message: `Precio vigente: RD$ ${priceText}.` }, { status: 201 });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    console.error("Error fijando precio:", error);
    return jsonError("No fue posible guardar el precio.", 500);
  } finally {
    client?.release();
  }
}
