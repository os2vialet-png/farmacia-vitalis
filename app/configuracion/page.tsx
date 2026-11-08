export const instant = false;
import { db } from "@/src/lib/db";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import AppShell from "@/src/components/AppShell";
import SettingsForm from "./SettingsForm";
import UsersManager from "../users/UsersManager";


export default async function SettingsPage() {
  const session = await requirePagePermission("settings.manage");

  const result = await db.query<{ key: string; value: string; description: string | null }>(
    `SELECT key, value, description FROM farmacia.app_settings
     WHERE key IN ('pharmacy_name', 'clinical_referral_text', 'receipt_footer')
     ORDER BY key`,
  );

  const branches = await db.query<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM farmacia.branches WHERE is_active = TRUE ORDER BY name`,
  );

  return (
    <AppShell session={session} activeItem="settings">
      <main className="mx-auto max-w-5xl space-y-8 p-4 md:p-8">
        <section className="space-y-6">
          <div>
            <h1 className="vitalis-heading text-2xl font-bold text-gray-900">Configuración</h1>
            <p className="mt-1 text-sm text-gray-500">
              Textos que aparecen en comprobantes, personal con sus roles y permisos. Cada cambio queda en auditoría.
            </p>
          </div>
          <SettingsForm settings={result.rows} />
          <p className="text-xs text-gray-500">
            Impuestos: se configuran producto por producto en el catálogo. Los productos sin impuesto configurado se tratan como exentos.
          </p>
        </section>

        <section className="border-t border-[var(--vitalis-line)] pt-6">
          <h2 className="vitalis-heading text-xl font-bold text-gray-900">Empleados y permisos</h2>
          <p className="mt-1 mb-4 text-sm text-gray-500">
            Cada empleado entra con su rol y su sucursal. El backend vuelve a validar cada permiso en todas las acciones.
          </p>
          <UsersManager
            branches={branches.rows}
            currentUser={`${session.user.firstName} ${session.user.lastName}`}
          />
        </section>
      </main>
    </AppShell>
  );
}
