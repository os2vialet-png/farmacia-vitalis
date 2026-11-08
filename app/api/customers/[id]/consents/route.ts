import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { consentSchema } from "@/src/lib/customers";

type Context = { params: Promise<{ id: string }> };

/**
 * Registra un cambio de consentimiento. Cada consentimiento es independiente:
 * otorgar o revocar uno de comunicaciones comerciales no afecta a los demás.
 * El historial es inmutable (triggers en la base de datos).
 */
export async function POST(request: NextRequest, context: Context) {
  try {
    const access = await authorize("customers.manage");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de cliente inválido.", 400);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = consentSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError("Datos de consentimiento no válidos.", 400);
    }

    const data = parsed.data;

    if (data.consentType === "personal_data_processing" && !data.granted) {
      return jsonError(
        "El tratamiento de datos es necesario para mantener la ficha del cliente. Para dejar de recibir comunicaciones, revoca el consentimiento comercial correspondiente.",
        400,
      );
    }

    const exists = await db.query(`SELECT id FROM farmacia.customers WHERE id = $1`, [id]);
    if (exists.rows.length === 0) {
      return jsonError("El cliente no existe.", 404);
    }

    const session = access.session;

    await db.query(
      `INSERT INTO farmacia.customer_consents (customer_id, consent_type, granted, source, recorded_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, data.consentType, data.granted, data.source, session.user.id],
    );

    await writeAudit(db, {
      actorUserId: session.user.id,
      action: data.granted ? "customer.consent_granted" : "customer.consent_revoked",
      entity: "customer",
      entityId: id,
      newValues: { consentType: data.consentType, granted: data.granted, source: data.source },
      ip: clientIp(request),
    });

    return NextResponse.json({ success: true, message: "Consentimiento registrado." }, { status: 201 });
  } catch (error) {
    console.error("Error registrando consentimiento:", error);
    return jsonError("No fue posible registrar el consentimiento.", 500);
  }
}
