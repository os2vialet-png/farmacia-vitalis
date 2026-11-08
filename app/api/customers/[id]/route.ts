import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { accessibleBranchIds } from "@/src/lib/access";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { customerUpdateSchema, maskDocument } from "@/src/lib/customers";

type Context = { params: Promise<{ id: string }> };

const uuid = z.string().uuid();

/**
 * Ficha del cliente: datos de contacto, estado actual de cada consentimiento,
 * historial de consentimientos e historial de compras en sucursales autorizadas.
 */
export async function GET(_request: NextRequest, context: Context) {
  try {
    const access = await authorize("customers.view");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    if (!uuid.safeParse(id).success) {
      return jsonError("Identificador de cliente inválido.", 400);
    }

    const customerResult = await db.query(
      `SELECT id, full_name, phone, email, document_number, address, notes, is_active,
              created_at, updated_at
       FROM farmacia.customers
       WHERE id = $1`,
      [id],
    );

    if (customerResult.rows.length === 0) {
      return jsonError("El cliente no existe.", 404);
    }

    const customer = customerResult.rows[0];

    const consents = await db.query(
      `SELECT DISTINCT ON (consent_type) consent_type, granted, recorded_at
       FROM farmacia.customer_consents
       WHERE customer_id = $1
       ORDER BY consent_type, recorded_at DESC, id DESC`,
      [id],
    );

    const consentHistory = await db.query(
      `SELECT consent_type, granted, source, recorded_at,
              TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS recorded_by_name
       FROM farmacia.customer_consents cc
       LEFT JOIN farmacia.users u ON u.id = cc.recorded_by
       WHERE cc.customer_id = $1
       ORDER BY cc.recorded_at DESC, cc.id DESC
       LIMIT 50`,
      [id],
    );

    const branchIds = await accessibleBranchIds(access.session, "sales.view");

    const purchases = branchIds.length === 0
      ? { rows: [] as unknown[] }
      : await db.query(
          `SELECT s.id, s.sale_number, s.status, s.total, s.created_at, b.name AS branch_name
           FROM farmacia.sales s
           INNER JOIN farmacia.branches b ON b.id = s.branch_id
           WHERE s.customer_id = $1 AND s.branch_id = ANY($2::uuid[])
           ORDER BY s.created_at DESC
           LIMIT 100`,
          [id, branchIds],
        );

    return NextResponse.json({
      success: true,
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        phone: customer.phone,
        email: customer.email,
        documentNumber: maskDocument(customer.document_number),
        address: customer.address,
        notes: customer.notes,
        isActive: customer.is_active,
        createdAt: customer.created_at,
      },
      consents: consents.rows,
      consentHistory: consentHistory.rows,
      purchases: purchases.rows,
    });
  } catch (error) {
    console.error("Error consultando cliente:", error);
    return jsonError("No fue posible consultar el cliente.", 500);
  }
}

/** Edita datos de contacto. El documento no se modifica desde aquí para evitar duplicados y errores. */
export async function PATCH(request: NextRequest, context: Context) {
  let client;

  try {
    const access = await authorize("customers.manage");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    if (!uuid.safeParse(id).success) {
      return jsonError("Identificador de cliente inválido.", 400);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = customerUpdateSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Datos no válidos.", 400);
    }

    const changes = parsed.data;

    client = await db.connect();
    await client.query("BEGIN");

    const current = await client.query(
      `SELECT full_name, phone, email, address, notes, is_active
       FROM farmacia.customers WHERE id = $1 FOR UPDATE`,
      [id],
    );

    if (current.rows.length === 0) {
      await client.query("ROLLBACK");
      return jsonError("El cliente no existe.", 404);
    }

    const before = current.rows[0];

    const next = {
      full_name: changes.fullName ?? before.full_name,
      phone: changes.phone !== undefined ? changes.phone || null : before.phone,
      email: changes.email !== undefined ? (changes.email ? changes.email.toLowerCase() : null) : before.email,
      address: changes.address !== undefined ? changes.address || null : before.address,
      notes: changes.notes !== undefined ? changes.notes || null : before.notes,
      is_active: changes.isActive ?? before.is_active,
    };

    await client.query(
      `UPDATE farmacia.customers
       SET full_name = $2, phone = $3, email = $4, address = $5, notes = $6,
           is_active = $7, updated_by = $8, updated_at = NOW()
       WHERE id = $1`,
      [id, next.full_name, next.phone, next.email, next.address, next.notes, next.is_active, access.session.user.id],
    );

    const diff: Record<string, { before: unknown; after: unknown }> = {};
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      if (before[key] !== next[key]) {
        // Los datos personales no se guardan en auditoría: solo se indica qué cambió.
        diff[key] = { before: null, after: null };
      }
    }

    await writeAudit(client, {
      actorUserId: access.session.user.id,
      action: next.is_active === false && before.is_active ? "customer.deactivate" : "customer.update",
      entity: "customer",
      entityId: id,
      newValues: { changedFields: Object.keys(diff) },
      ip: clientIp(request),
    });

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    return NextResponse.json({ success: true, message: "Cliente actualizado." });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    console.error("Error actualizando cliente:", error);
    return jsonError("No fue posible actualizar el cliente.", 500);
  } finally {
    client?.release();
  }
}
