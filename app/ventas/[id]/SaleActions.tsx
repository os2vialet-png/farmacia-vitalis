"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function SaleActions({ saleId, canCancel }: { saleId: string; canCancel: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function cancelSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch(`/api/sales/${saleId}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "No fue posible anular la venta.");
        return;
      }

      setOpen(false);
      setReason("");
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servidor. Revisa si la venta quedó anulada antes de reintentar.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4 print:hidden">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/ventas" className="text-sm text-gray-600 hover:text-gray-900">
          ← Volver al historial
        </Link>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
          >
            Imprimir comprobante
          </button>
          {canCancel && (
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-700 hover:bg-red-50"
            >
              Anular venta
            </button>
          )}
        </div>
      </div>

      {open && canCancel && (
        <form onSubmit={cancelSale} className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-800">
            Al anular, las unidades vuelven al inventario de los mismos lotes. La anulación queda registrada y no se puede deshacer.
          </p>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-red-900">Motivo de la anulación</span>
            <textarea
              required
              minLength={10}
              maxLength={300}
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="w-full rounded border border-red-300 bg-white px-3 py-2 text-sm"
            />
          </label>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          <button
            type="submit"
            disabled={loading || reason.trim().length < 10}
            className="rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {loading ? "Anulando..." : "Confirmar anulación"}
          </button>
        </form>
      )}
    </div>
  );
}
