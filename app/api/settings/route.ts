import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";

/** Claves que se pueden editar desde la interfaz. La moneda y otras claves técnicas no se editan aquí. */
const EDITABLE_KEYS = ["pharmacy_name", "clinical_referral_text", "receipt_footer"] as const;

const updateSchema = z.object({
  key: z.enum(EDITABLE_KEYS),
  value: z.string().trim().min(1, "El valor no puede estar vacío.").max(500),
});

export async function GET() {
  try {
    const access = await authorize("settings.manage");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const result = await db.query(
      `SELECT key, value, description, updated_at FROM farmacia.app_settings ORDER BY key`,
    );

    return NextResponse.json({ success: true, settings: result.rows });
  } catch (error) {
    console.error("Error consultando configuración:", error);
    return jsonError("No fue posible consultar la configuración.", 500);
  }
}

export async function PATCH(request: NextRequest) {
  let client;

  try {
    const access = await authorize("settings.manage");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = updateSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Dato no válido.", 400);
    }

    client = await db.connect();
    await client.query("BEGIN");

    const current = await client.query<{ value: string }>(
      `SELECT value FROM farmacia.app_settings WHERE key = $1 FOR UPDATE`,
      [parsed.data.key],
    );

    if (current.rows.length === 0) {
      await client.query("ROLLBACK");
      return jsonError("La configuración no existe.", 404);
    }

    await client.query(
      `UPDATE farmacia.app_settings SET value = $2, updated_by = $3, updated_at = NOW() WHERE key = $1`,
      [parsed.data.key, parsed.data.value, access.session.user.id],
    );

    await writeAudit(client, {
      actorUserId: access.session.user.id,
      action: "settings.update",
      entity: "app_setting",
      entityId: null,
      oldValues: { key: parsed.data.key, value: current.rows[0].value },
      newValues: { key: parsed.data.key, value: parsed.data.value },
      ip: clientIp(request),
    });

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    return NextResponse.json({ success: true, message: "Configuración guardada." });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    console.error("Error guardando configuración:", error);
    return jsonError("No fue posible guardar la configuración.", 500);
  } finally {
    client?.release();
  }
}
