export const instant = false;
import { redirect } from "next/navigation";
import { db } from "@/src/lib/db";
import { requireSessionPage } from "@/src/lib/auth/page-guard";
import { isOwner } from "@/src/lib/auth/permissions";
import UsersManager from "./UsersManager";
import AppShell from "@/src/components/AppShell";

export default async function UsersPage() {
  const session = await requireSessionPage();

  if (!isOwner(session)) {
    redirect("/dashboard");
  }

  const result = await db.query<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM farmacia.branches WHERE is_active = TRUE ORDER BY name`,
  );

  return (
    <AppShell session={session} activeItem="settings">
      <main className="mx-auto max-w-5xl p-4 md:p-8">
        <div>
          <h1 className="vitalis-heading text-2xl font-bold text-gray-900">Empleados y permisos</h1>
          <p className="mt-1 text-sm text-gray-500">
            Puedes leer esta página de forma directa en /users; todo también vive dentro de Configuración.
          </p>
        </div>
        <UsersManager
          branches={result.rows}
          currentUser={`${session.user.firstName} ${session.user.lastName}`}
        />
      </main>
    </AppShell>
  );
}
