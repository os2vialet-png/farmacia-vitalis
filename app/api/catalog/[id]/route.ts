import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { catalogUpdateSchema, percentToRate } from "@/src/lib/catalog";

type Context = { params: Promise<{ id: string }> };

/**
 * Edita datos comerciales del producto. No cambia la verificación (eso va por /verify)
 * ni los precios (van por /prices). Cada cambio queda en auditoría con los campos modificados.
 */
export async function PATCH(request: NextRequest, context: Context) {
  let client;

  try {
    const access = await authorize("catalog.update");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de producto inválido.", 400);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = catalogUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Datos no válidos.", 400);
    }

    const changes = parsed.data;

    client = await db.connect();
    await client.query("BEGIN");

    const current = await client.query(
      `SELECT product_name, brand_name, strength, presentation, sale_unit, tax_rate,
              is_active, is_prescription, is_controlled
       FROM farmacia.catalog_products WHERE id = $1 FOR UPDATE`,
      [id],
    );

    if (current.rows.length === 0) {
      await client.query("ROLLBACK");
      return jsonError("El producto no existe.", 404);
    }

    const before = current.rows[0];

    const next = {
      brand_name: changes.brandName !== undefined ? changes.brandName || null : before.brand_name,
      strength: changes.strength !== undefined ? changes.strength || null : before.strength,
      presentation: changes.presentation !== undefined ? changes.presentation || null : before.presentation,
      sale_unit: changes.saleUnit !== undefined ? changes.saleUnit || null : before.sale_unit,
      tax_rate: changes.taxPercent !== undefined ? percentToRate(changes.taxPercent) : before.tax_rate,
      is_active: changes.isActive ?? before.is_active,
      is_prescription: changes.isPrescription ?? before.is_prescription,
      is_controlled: changes.isControlled ?? before.is_controlled,
    };

    await client.query(
      `UPDATE farmacia.catalog_products
       SET brand_name = $2, strength = $3, presentation = $4, sale_unit = $5, tax_rate = $6,
           is_active = $7, is_prescription = $8, is_controlled = $9, updated_at = NOW()
       WHERE id = $1`,
      [
        id,
        next.brand_name,
        next.strength,
        next.presentation,
        next.sale_unit,
        next.tax_rate,
        next.is_active,
        next.is_prescription,
        next.is_controlled,
      ],
    );

    const changedFields = (Object.keys(next) as (keyof typeof next)[]).filter(
      (key) => String(before[key] ?? "") !== String(next[key] ?? ""),
    );

    await writeAudit(client, {
      actorUserId: access.session.user.id,
      action: "catalog.update",
      entity: "catalog_product",
      entityId: id,
      oldValues: Object.fromEntries(changedFields.map((key) => [key, before[key]])),
      newValues: Object.fromEntries(changedFields.map((key) => [key, next[key]])),
      ip: clientIp(request),
    });

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    return NextResponse.json({ success: true, message: "Producto actualizado.", changedFields });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    console.error("Error actualizando producto:", error);
    return jsonError("No fue posible actualizar el producto.", 500);
  } finally {
    client?.release();
  }
}
