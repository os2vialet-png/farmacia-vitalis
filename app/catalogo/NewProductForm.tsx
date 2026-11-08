"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

const FIELDS = [
  ["productName", "Nombre comercial *", 200],
  ["brandName", "Marca", 120],
  ["dosageForm", "Forma farmacéutica (tableta, jarabe…)", 120],
  ["strength", "Concentración (ej. 500 mg)", 60],
  ["presentation", "Presentación (ej. caja x 20)", 160],
  ["saleUnit", "Unidad de venta (ej. caja)", 60],
  ["sanitaryRegistration", "Registro sanitario", 40],
] as const;

export default function NewProductForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const get = (name: string) => String(form.get(name) ?? "").trim() || undefined;
    const tax = get("taxPercent");

    setBusy(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...Object.fromEntries(FIELDS.map(([key]) => [key, get(key)])),
          taxPercent: tax === undefined ? null : Number(tax),
          isPrescription: form.get("isPrescription") === "on",
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "No fue posible crear el producto.");
        return;
      }
      formElement.reset();
      setMessage(data.message);
      router.push(`/catalogo/${data.product.id}`);
    } catch {
      setError("No se pudo confirmar por un problema de conexión. Busca el producto antes de reintentar.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white hover:bg-[#008f45]">
        + Nuevo producto
      </button>
    );
  }

  const inputClass = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00A651]";

  return (
    <form onSubmit={submit} className="grid gap-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm md:grid-cols-2">
      <h2 className="text-lg font-semibold md:col-span-2">Nuevo producto</h2>
      <p className="text-xs text-gray-500 md:col-span-2">
        Entra activo para compras y <strong>pendiente de verificación</strong>: no se vende hasta que un farmacéutico lo verifique.
      </p>
      {FIELDS.map(([key, label, max]) => (
        <label key={key} className="text-sm">
          <span className="mb-1 block font-medium text-gray-700">{label}</span>
          <input name={key} required={key === "productName"} maxLength={max} className={inputClass} />
        </label>
      ))}
      <label className="text-sm">
        <span className="mb-1 block font-medium text-gray-700">Impuesto % (vacío = exento)</span>
        <input name="taxPercent" type="number" min={0} max={100} step="0.01" className={inputClass} />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input name="isPrescription" type="checkbox" /> Requiere receta
      </label>
      {error && <p role="alert" className="text-sm text-red-700 md:col-span-2">{error}</p>}
      {message && <p role="status" className="text-sm text-green-700 md:col-span-2">{message}</p>}
      <div className="flex gap-2 md:col-span-2">
        <button type="submit" disabled={busy} className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
          {busy ? "Guardando..." : "Crear producto"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">Cancelar</button>
      </div>
    </form>
  );
}
