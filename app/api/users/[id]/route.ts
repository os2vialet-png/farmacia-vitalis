import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus, isOwner } from "@/src/lib/auth/permissions";
import { hashPassword } from "@/src/lib/auth/password";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { BusinessError, isBusinessError } from "@/src/lib/errors";

type Context = { params: Promise<{ id: string }> };

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("deactivate") }),
  z.object({ action: z.literal("activate") }),
  z.object({ action: z.literal("reset_password") }),
  z.object({
    action: z.literal("set_role"),
    roleCode: z.enum(["admin", "pharmacist", "inventory_manager", "seller"]),
    branchId: z.string().uuid(),
  }),
]);

/** Contraseña temporal con al menos una letra y un número. */
function temporaryPassword(): string {
  return `${randomBytes(18).toString("base64url")}7k`;
}

/**
 * Gestión de una cuenta de empleado. Solo el propietario. No se aplica a cuentas de propietario
 * (se recuperan con scripts/reset-owner-password.ts) ni a la propia cuenta.
 * Desactivar o restablecer la contraseña revoca de inmediato todas las sesiones del empleado.
 */
export async function PATCH(request: NextRequest, context: Context) {
  let client;

  try {
    const access = await authorize("users.manage");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    if (!isOwner(access.session)) {
      return jsonError("Solo el propietario puede administrar empleados.", 403);
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de usuario inválido.", 400);
    }

    if (id === access.session.user.id) {
      return jsonError("No puedes aplicar esta acción a tu propia cuenta.", 400);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = actionSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError("Acción no válida.", 400);
    }

    const data = parsed.data;
    const ip = clientIp(request);
    const actor = access.session.user.id;

    // El hash se calcula fuera de la transacción: scrypt es costoso y no debe retener bloqueos.
    const newPassword = data.action === "reset_password" ? temporaryPassword() : null;
    const newHash = newPassword ? await hashPassword(newPassword) : null;

    client = await db.connect();
    await client.query("BEGIN");

    const target = await client.query<{ username: string; is_active: boolean; is_owner: boolean }>(
      `SELECT u.username, u.is_active,
              EXISTS (
                SELECT 1 FROM farmacia.user_roles ur
                INNER JOIN farmacia.roles r ON r.id = ur.role_id
                WHERE ur.user_id = u.id AND r.code = 'owner'
              ) AS is_owner
       FROM farmacia.users u
       WHERE u.id = $1
       FOR UPDATE OF u`,
      [id],
    );

    if (target.rows.length === 0) {
      throw new BusinessError("El usuario no existe.", 404);
    }

    if (target.rows[0].is_owner) {
      throw new BusinessError("Las cuentas de propietario no se administran desde aquí.", 403);
    }

    const username = target.rows[0].username;

    if (data.action === "deactivate" || data.action === "activate") {
      const active = data.action === "activate";
      await client.query(`UPDATE farmacia.users SET is_active = $2, updated_at = NOW() WHERE id = $1`, [id, active]);
      if (!active) {
        await client.query(`UPDATE farmacia.user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      }
      await writeAudit(client, {
        actorUserId: actor,
        action: active ? "user.activate" : "user.deactivate",
        entity: "user",
        entityId: id,
        oldValues: { isActive: target.rows[0].is_active },
        newValues: { isActive: active, username },
        ip,
      });
    }

    if (data.action === "reset_password") {
      await client.query(
        `UPDATE farmacia.users SET password_hash = $2, must_change_password = TRUE, updated_at = NOW() WHERE id = $1`,
        [id, newHash],
      );
      await client.query(`UPDATE farmacia.user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      await writeAudit(client, {
        actorUserId: actor,
        action: "user.password_reset",
        entity: "user",
        entityId: id,
        newValues: { username, mustChangePassword: true },
        ip,
      });
    }

    if (data.action === "set_role") {
      const role = await client.query<{ id: string }>(`SELECT id FROM farmacia.roles WHERE code = $1`, [data.roleCode]);
      const branch = await client.query(`SELECT id FROM farmacia.branches WHERE id = $1 AND is_active = TRUE FOR SHARE`, [data.branchId]);
      if (role.rows.length === 0 || branch.rows.length === 0) {
        throw new BusinessError("El rol o la sucursal no existen.", 400);
      }

      const previous = await client.query<{ code: string; branch_id: string | null }>(
        `SELECT r.code, ur.branch_id FROM farmacia.user_roles ur
         INNER JOIN farmacia.roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
        [id],
      );

      await client.query(`DELETE FROM farmacia.user_roles WHERE user_id = $1`, [id]);
      await client.query(
        `INSERT INTO farmacia.user_roles (user_id, role_id, branch_id) VALUES ($1, $2, $3)`,
        [id, role.rows[0].id, data.branchId],
      );

      await writeAudit(client, {
        actorUserId: actor,
        branchId: data.branchId,
        action: "user.role_change",
        entity: "user",
        entityId: id,
        oldValues: { roles: previous.rows },
        newValues: { roleCode: data.roleCode, branchId: data.branchId, username },
        ip,
      });
    }

    await client.query("COMMIT");
    client.release();
    client = undefined;

    return NextResponse.json({
      success: true,
      message: {
        deactivate: "Empleado desactivado. Sus sesiones se cerraron.",
        activate: "Empleado reactivado.",
        reset_password: "Contraseña restablecida. El empleado deberá cambiarla al entrar.",
        set_role: "Rol actualizado. Aplica desde la siguiente acción del empleado.",
      }[data.action],
      ...(newPassword ? { temporaryPassword: newPassword } : {}),
    });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    if (isBusinessError(error)) return jsonError(error.message, error.status);
    console.error("Error administrando empleado:", error);
    return jsonError("No fue posible completar la acción.", 500);
  } finally {
    client?.release();
  }
}
