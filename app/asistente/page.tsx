import AssistantChat from "./AssistantChat";

export const metadata = {
  title: "Asistente Vitalis",
};

export default function AssistantPage() {
  return (
    <main className="min-h-screen bg-[#f4f6f8] p-4 md:p-10">
      <div className="mx-auto max-w-2xl space-y-4">
        <header className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#00A651] text-xl font-bold text-white">V</div>
          <div>
            <h1 className="text-lg font-bold text-gray-900">Asistente Vitalis</h1>
            <p className="text-xs text-gray-500">Farmacia Vitalis · consulta de disponibilidad y precios</p>
          </div>
        </header>

        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          Este asistente informa disponibilidad, presentación, unidad de venta y precio del catálogo verificado.
          No diagnostica, no recomienda medicamentos y no revela cantidades de inventario. Para consultas clínicas,
          habla con un farmacéutico. En una emergencia, llama al 911.
        </div>

        <AssistantChat />
      </div>
    </main>
  );
}
