export const instant = false;
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import { interpret } from "@/src/lib/owner-assistant";
import { llmEnabled } from "@/src/lib/llm-intent";
import { cloudAiEnabled } from "@/src/lib/ai-client";
import AppShell from "@/src/components/AppShell";
import OwnerAssistant from "./OwnerAssistant";

export default async function OwnerAssistantPage() {
  const session = await requirePagePermission("users.view");
  // Avisos del negocio al abrir: el asistente avisa sin que haya que pedirlo.
  const alerts = await interpret(session, "avisos");
  const cloud = cloudAiEnabled();
  const local = llmEnabled();
  const badge = cloud
    ? { tone: "bg-green-50 text-green-800", text: "IA en la nube activa: entiende frases libres, el contexto de la conversación y notas de voz" }
    : local
      ? { tone: "bg-amber-50 text-amber-800", text: "IA local activa (solo en esta computadora). Para notas de voz y uso en la web, configura AI_API_KEY (docs/IA.md)" }
      : { tone: "bg-gray-100 text-gray-600", text: "Modo órdenes básicas: configura la IA gratuita para frases libres y voz (docs/IA.md)" };

  return (
    <AppShell session={session} activeItem="owner-assistant">
      <main className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Asistente del dueño</h1>
          <p className="mt-1 text-sm text-gray-500">
            Pide tareas en español. Antes de cambiar algo te muestro qué haré y espero tu confirmación. Puedes deshacer con «deshacer». Todo queda en auditoría.
          </p>
          <p className={`mt-2 inline-block rounded-full px-3 py-1 text-xs font-medium ${badge.tone}`}>{badge.text}</p>
        </div>
        <OwnerAssistant firstName={session.user.firstName} initialReply={alerts.reply} initialBullets={alerts.bullets ?? []} voiceEnabled={cloud} />
      </main>
    </AppShell>
  );
}
