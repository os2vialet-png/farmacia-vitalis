import "server-only";

import { db } from "@/src/lib/db";
import type { AuthSession, PermissionCode } from "@/src/lib/auth/permissions";

/**
 * Sucursales activas a las que la sesión tiene el permiso indicado.
 * Un rol global (branchId = null) da acceso a todas las sucursales activas.
 * Una sesión con contraseña temporal no obtiene ninguna sucursal.
 */
export async function accessibleBranchIds(
  session: AuthSession,
  permission: PermissionCode,
): Promise<string[]> {
  if (session.user.mustChangePassword) return [];

  const branches = await db.query<{ id: string }>(
    `SELECT id FROM farmacia.branches WHERE is_active = TRUE ORDER BY name`,
  );

  const hasGlobal = session.roles.some(
    (role) => role.branchId === null && role.permissions.includes(permission),
  );

  if (hasGlobal) return branches.rows.map((row) => row.id);

  const scoped = new Set(
    session.roles
      .filter((role) => role.branchId !== null && role.permissions.includes(permission))
      .map((role) => role.branchId as string),
  );

  return branches.rows.map((row) => row.id).filter((id) => scoped.has(id));
}

/** Es verdadero solo si la sesión puede operar esa sucursal con ese permiso. */
export async function canOperateBranch(
  session: AuthSession,
  permission: PermissionCode,
  branchId: string,
): Promise<boolean> {
  const allowed = await accessibleBranchIds(session, permission);
  return allowed.includes(branchId);
}
