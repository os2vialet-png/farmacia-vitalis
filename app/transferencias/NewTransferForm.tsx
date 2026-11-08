"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Option = { id: string; name: string };
type Product = { id: string; product_name: string; brand_name: string | null; presentation: string | null; sale_unit: string | null };
type Line = { product: Product; quantity: number };

export default function NewTransferForm({
  destinationBranchId,
  originOptions,
}: {
  destinationBranchId: string;
  originOptions: Option[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [originBranchId, setOriginBranchId] = useState(originOptions[0]?.id ?? "");
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const trimmed = term.trim();
    if (trimmed.length < 2) {
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/catalog/search?q=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
        const data = await response.json();
        if (!cancelled) setResults(data.products || []);
      } catch {
        if (!cancelled) setResults([]);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  function addLine(product: Product) {
    setLines((current) =>
      current.some((line) => line.product.id === product.id)
        ? current
        : [...current, { product, quantity: 1 }],
    );
    setTerm("");
    setResults([]);
  }

  const visibleResults = term.trim().length >= 2 ? results : [];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (lines.length === 0) {
      setError("Agrega al menos un producto.");
      return;
    }

    setBusy(true);
    try {
      const response = await fetch("/api/transfers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originBranchId,
          destinationBranchId,
          notes: notes.trim() || undefined,
          items: lines.map((line) => ({ productId: line.product.id, quantity: line.quantity })),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "No fue posible crear la solicitud.");
        return;
      }
      setLines([]);
      setNotes("");
      setOpen(false);
      router.refresh();
      router.push(`/transferencias/${data.transfer.id}`);
    } catch {
      setError("No se pudo conectar con el servidor.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white hover:bg-[#008f45]">
        + Solicitar mercancía
      </button>
    );
  }

  const inputClass = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00A651]";

  return (
    <form onSubmit={submit} className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold">Nueva solicitud</h2>

      <label className="block max-w-md text-sm">
        <span className="mb-1 block font-medium text-gray-700">Sucursal que envía (origen)</span>
        <select className={inputClass} value={originBranchId} onChange={(event) => setOriginBranchId(event.target.value)}>
          {originOptions.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700">Buscar producto</span>
        <input className={inputClass} value={term} onChange={(event) => setTerm(event.target.value)} placeholder="Nombre, marca o registro" />
      </label>
      {visibleResults.length > 0 && (
        <div className="max-h-56 divide-y overflow-y-auto rounded-lg border border-gray-200">
          {visibleResults.map((product) => (
            <button key={product.id} type="button" onClick={() => addLine(product)} className="block w-full px-3 py-2 text-left text-sm hover:bg-green-50">
              {product.product_name}
              <span className="text-xs text-gray-500"> · {[product.brand_name, product.presentation].filter(Boolean).join(" · ")}</span>
            </button>
          ))}
        </div>
      )}

      {lines.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-gray-500">
            <tr>
              <th className="py-2">Producto</th>
              <th className="py-2">Cantidad</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.map((line) => (
              <tr key={line.product.id}>
                <td className="py-2">{line.product.product_name}</td>
                <td className="py-2">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={line.quantity}
                    onChange={(event) =>
                      setLines((current) =>
                        current.map((item) =>
                          item.product.id === line.product.id ? { ...item, quantity: Math.floor(Number(event.target.value)) || 0 } : item,
                        ),
                      )
                    }
                    className="w-28 rounded border border-gray-300 px-2 py-1"
                  />
                </td>
                <td className="py-2 text-right">
                  <button type="button" onClick={() => setLines((current) => current.filter((item) => item.product.id !== line.product.id))} className="text-red-600 hover:underline">
                    Quitar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <label className="block text-sm">
        <span className="mb-1 block font-medium text-gray-700">Notas (opcional)</span>
        <textarea rows={2} maxLength={500} className={inputClass} value={notes} onChange={(event) => setNotes(event.target.value)} />
      </label>

      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

      <div className="flex gap-2">
        <button type="submit" disabled={busy || lines.length === 0} className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? "Enviando..." : "Enviar solicitud"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">Cancelar</button>
      </div>
    </form>
  );
}
