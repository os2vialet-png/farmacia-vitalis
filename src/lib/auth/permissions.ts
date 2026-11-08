
import "server-only";

import { getSession } from "@/src/lib/auth/session";

export type PermissionCode =
  | "branches.view"
  | "branches.manage"
  | "users.view"
  | "users.manage"
  | "users.assign_roles"
  | "catalog.view"
  | "catalog.create"
  | "catalog.update"
  | "catalog.verify"
  | "catalog.prices"
  | "inventory.view"
  | "inventory.manage"
  | "inventory.adjust"
  | "sales.view"
  | "sales.create"
  | "sales.cancel"
  | "sales.discount"
  | "customers.view"
  | "customers.manage"
  | "purchases.view"
  | "purchases.create"
  | "purchases.approve"
  | "transfers.view"
  | "transfers.request"
  | "transfers.approve"
  | "transfers.dispatch"
  | "transfers.receive"
  | "transfers.reconcile"
  | "reports.view"
  | "settings.manage"
  | "audit.view"
  | "assistant.use";

export type AuthSession = NonNullable<
  Awaited<ReturnType<typeof getSession>>
>;

/**
 * Único punto de decisión de permisos. Una sesión con contraseña temporal
 * no tiene ningún permiso hasta cambiarla.
 */
export function hasPermission(
  session: AuthSession,
  permission: PermissionCode,
  branchId?: string,
): boolean {
  if (session.user.mustChangePassword) {
    return false;
  }

  return session.roles.some((role) => {
    if (!role.permissions.includes(permission)) {
      return false;
    }

    // Los roles globales aplican a todas las sucursales.
    if (role.branchId === null) {
      return true;
    }

    // Sin sucursal específica, basta con tener el permiso en alguna sucursal asignada.
    // Las consultas que listan datos deben filtrar después por sucursal (ver src/lib/access.ts).
    if (!branchId) {
      return true;
    }

    return role.branchId === branchId;
  });
}

export function isOwner(session: AuthSession): boolean {
  return !session.user.mustChangePassword && session.roles.some((role) => role.code === "owner");
}

export async function authorize(
  permission: PermissionCode,
  branchId?: string,
) {
  const session = await getSession();

  if (!session) {
    return {
      authorized: false as const,
      reason: "unauthenticated" as const,
      session: null,
    };
  }

  if (session.user.mustChangePassword) {
    return {
      authorized: false as const,
      reason: "password_change_required" as const,
      session,
    };
  }

  if (!hasPermission(session, permission, branchId)) {
    return {
      authorized: false as const,
      reason: "forbidden" as const,
      session,
    };
  }

  return {
    authorized: true as const,
    reason: null,
    session,
  };
}

/** Código HTTP correspondiente a un fallo de autorización. */
export function authorizationStatus(reason: "unauthenticated" | "password_change_required" | "forbidden"): number {
  return reason === "unauthenticated" ? 401 : 403;
}

export function authorizationMessage(reason: "unauthenticated" | "password_change_required" | "forbidden"): string {
  switch (reason) {
    case "unauthenticated":
      return "Debes iniciar sesión.";
    case "password_change_required":
      return "Debes cambiar tu contraseña temporal antes de usar el sistema.";
    default:
      return "No tienes permiso para realizar esta acción.";
  }
}
