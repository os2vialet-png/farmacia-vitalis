export const instant = false;
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import { interpret } from "@/src/lib/owner-assistant";
import { llmEnabled } from "@/src/lib/llm-intent";
import AppShell from "@/src/components/AppShell";
import OwnerAssistant from "./OwnerAssistant";

export default async function OwnerAssistantPage() {
  const session = await requirePagePermission("users.view");
  // Avisos del negocio al abrir: el asistente avisa sin que haya que pedirlo.
  const alerts = await interpret(session, "avisos");
  const aiEnabled = llmEnabled();

  return (
    <AppShell session={session} activeItem="owner-assistant">
      <main className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Asistente del dueño</h1>
          <p className="mt-1 text-sm text-gray-500">
            Pide tareas en español. Antes de cambiar algo te muestro qué haré y espero tu confirmación. Puedes deshacer con «deshacer». Todo queda en auditoría.
          </p>
          <p className={`mt-2 inline-block rounded-full px-3 py-1 text-xs font-medium ${aiEnabled ? "bg-green-50 text-green-800" : "bg-gray-100 text-gray-600"}`}>
            {aiEnabled ? "IA local activa (gratuita, en esta computadora): entiende frases libres" : "Modo órdenes: instala la IA local gratuita para frases libres (ver docs/PRESENTACION.md)"}
          </p>
        </div>
        <OwnerAssistant firstName={session.user.firstName} initialReply={alerts.reply} initialBullets={alerts.bullets ?? []} />
      </main>
    </AppShell>
  );
}
