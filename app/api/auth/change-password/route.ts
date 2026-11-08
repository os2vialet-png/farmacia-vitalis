import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { createSession, getSession } from "@/src/lib/auth/session";
import { hashPassword, verifyPassword } from "@/src/lib/auth/password";
import { validatePasswordPolicy } from "@/src/lib/auth/policy";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";

const FAILURE_WINDOW_MINUTES = 15;
const MAX_FAILURES = 5;

const schema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(1).max(128),
  confirmPassword: z.string().min(1).max(128),
});

/**
 * Cambio de contraseña. Permitido también cuando la contraseña es temporal
 * (es el único endpoint que funciona en ese estado, junto con logout).
 * Al cambiarla se revocan todas las sesiones anteriores y se crea una nueva.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();

    if (!session) {
      return jsonError("Debes iniciar sesión.", 401);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);

    if (!parsed.success) {
      return jsonError("Revisa los datos enviados.", 400);
    }

    const { currentPassword, newPassword, confirmPassword } = parsed.data;
    const userId = session.user.id;
    const ip = clientIp(request);

    const failures = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
       FROM farmacia.audit_logs
       WHERE action = 'password.change_failed'
         AND actor_user_id = $1
         AND created_at > NOW() - make_interval(mins => $2::int)`,
      [userId, FAILURE_WINDOW_MINUTES],
    );

    if (failures.rows[0].n >= MAX_FAILURES) {
      return jsonError(
        `Demasiados intentos fallidos. Espera ${FAILURE_WINDOW_MINUTES} minutos antes de volver a intentar.`,
        429,
      );
    }

    const userResult = await db.query(
      `SELECT username, password_hash FROM farmacia.users WHERE id = $1 AND is_active = TRUE`,
      [userId],
    );

    if (userResult.rows.length === 0) {
      return jsonError("Debes iniciar sesión.", 401);
    }

    const { username, password_hash: passwordHash } = userResult.rows[0];

    const currentIsValid = await verifyPassword(currentPassword, passwordHash);

    if (!currentIsValid) {
      await writeAudit(db, {
        actorUserId: userId,
        action: "password.change_failed",
        entity: "user",
        entityId: userId,
        ip,
      });
      return jsonError("La contraseña actual no es correcta.", 400);
    }

    if (newPassword !== confirmPassword) {
      return jsonError("La nueva contraseña y su confirmación no coinciden.", 400);
    }

    if (newPassword === currentPassword) {
      return jsonError("La nueva contraseña debe ser diferente a la actual.", 400);
    }

    const policyError = validatePasswordPolicy(newPassword, username);

    if (policyError) {
      return jsonError(policyError, 400);
    }

    const newHash = await hashPassword(newPassword);

    const client = await db.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE farmacia.users
         SET password_hash = $2, must_change_password = FALSE, updated_at = NOW()
         WHERE id = $1`,
        [userId, newHash],
      );

      await client.query(
        `UPDATE farmacia.user_sessions
         SET revoked_at = NOW()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [userId],
      );

      await writeAudit(client, {
        actorUserId: userId,
        action: "password.change",
        entity: "user",
        entityId: userId,
        newValues: { forced: session.user.mustChangePassword },
        ip,
      });

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    await createSession(userId);

    return NextResponse.json({
      success: true,
      message: "Contraseña actualizada correctamente.",
      redirectTo: "/dashboard",
    });
  } catch (error) {
    console.error("Error cambiando contraseña:", error);
    return jsonError("No fue posible cambiar la contraseña.", 500);
  }
}
