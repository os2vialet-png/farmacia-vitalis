import "server-only";

import { redirect } from "next/navigation";
import { getSession } from "@/src/lib/auth/session";
import type { PermissionCode } from "@/src/lib/auth/permissions";

/** Exige sesión activa y contraseña ya cambiada. Úsalo en todas las páginas protegidas. */
export async function requireSessionPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  if (session.user.mustChangePassword) {
    redirect("/cambiar-contrasena");
  }

  return session;
}

/** Igual que requireSessionPage, pero además exige un permiso en al menos una sucursal. */
export async function requirePagePermission(permission: PermissionCode) {
  const session = await requireSessionPage();

  const allowed = session.roles.some((role) => role.permissions.includes(permission));

  if (!allowed) {
    redirect("/dashboard");
  }

  return session;
}
