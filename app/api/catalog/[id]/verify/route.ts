import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { verifySchema } from "@/src/lib/catalog";

type Context = { params: Promise<{ id: string }> };

/**
 * Verificación auditable de un producto.
 * Para marcar "verified" con evidencia de registro sanitario, el servidor comprueba que el número
 * exista en el registro oficial importado, que esté VIGENTE, no vencido, y que el nombre coincida.
 * Nunca se verifica por lote: cada producto requiere su propia decisión.
 */
export async function POST(request: NextRequest, context: Context) {
  let client;

  try {
    const access = await authorize("catalog.verify");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de producto inválido.", 400);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = verifySchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Datos de verificación no válidos.", 400);
    }

    const data = parsed.data;

    if (data.status === "verified" && data.evidenceType === "manual_review" && (data.notes ?? "").length < 20) {
      return jsonError("Una verificación manual requiere una justificación de al menos 20 caracteres.", 400);
    }

    client = await db.connect();
    await client.query("BEGIN");

    const product = await client.query<{
      product_name: string;
      normalized_name: string;
      sanitary_registration: string | null;
      verification_status: string;
    }>(
      `SELECT product_name, normalized_name, sanitary_registration, verification_status
       FROM farmacia.catalog_products WHERE id = $1 FOR UPDATE`,
      [id],
    );

    if (product.rows.length === 0) {
      await client.query("ROLLBACK");
      return jsonError("El producto no existe.", 404);
    }

    const row = product.rows[0];

    if (data.status === "verified" && data.evidenceType === "sanitary_registry") {
      const evidence = await client.query(
        `SELECT 1
         FROM farmacia.catalog_product_registrations r
         WHERE r.sanitary_registration = $1
           AND r.sanitary_registration = $2
           AND r.registration_status = 'VIGENTE'
           AND (r.expiration_date IS NULL OR r.expiration_date >= CURRENT_DATE)
           AND btrim(regexp_replace(lower(r.product_name), '[^a-z0-9]+', ' ', 'g'))
               = btrim(regexp_replace(lower($3), '[^a-z0-9]+', ' ', 'g'))
         LIMIT 1`,
        [data.evidenceReference, row.sanitary_registration, row.product_name],
      );

      if (evidence.rows.length === 0) {
        await client.query("ROLLBACK");
        return jsonError(
          "La evidencia no coincide: el registro sanitario debe estar vigente en el registro oficial y tener el mismo nombre del producto.",
          409,
        );
      }
    }

    await client.query(
      `UPDATE farmacia.catalog_products
       SET verification_status = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, data.status],
    );

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO farmacia.catalog_verifications
         (product_id, previous_status, new_status, evidence_type, evidence_reference, notes, verified_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [id, row.verification_status, data.status, data.evidenceType, data.evidenceReference, data.notes ?? null, access.session.user.id],
    );

    await writeAudit(client, {
      actorUserId: access.session.user.id,
      action: "catalog.verify",
      entity: "catalog_product",
      entityId: id,
      oldValues: { verificationStatus: row.verification_status },
      newValues: { verificationStatus: data.status, evidenceType: data.evidenceType, verificationId: inserted.rows[0].id },
      ip: clientIp(request),
    });

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    return NextResponse.json({ success: true, message: "Verificación registrada." }, { status: 201 });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    console.error("Error verificando producto:", error);
    return jsonError("No fue posible registrar la verificación.", 500);
  } finally {
    client?.release();
  }
}
