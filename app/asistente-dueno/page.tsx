export const instant = false;
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import AppShell from "@/src/components/AppShell";
import OwnerAssistant from "./OwnerAssistant";

export default async function OwnerAssistantPage() {
  const session = await requirePagePermission("users.view");

  return (
    <AppShell session={session} activeItem="owner-assistant">
      <main className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Asistente del dueño</h1>
          <p className="mt-1 text-sm text-gray-500">
            Pide tareas en español. Antes de cambiar algo te muestro qué haré y espero tu confirmación. Todo queda en auditoría.
          </p>
        </div>
        <OwnerAssistant firstName={session.user.firstName} />
      </main>
    </AppShell>
  );
}
