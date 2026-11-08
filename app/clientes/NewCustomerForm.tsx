"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

const COMMERCIAL = [
  { key: "commercial_whatsapp", label: "WhatsApp" },
  { key: "commercial_email", label: "Correo" },
  { key: "commercial_sms", label: "SMS" },
] as const;

export default function NewCustomerForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [answers, setAnswers] = useState<Record<string, boolean | undefined>>({});

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    // React libera event.currentTarget al terminar el manejador síncrono: se guarda antes del await.
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const get = (name: string) => String(form.get(name) ?? "").trim();

    const commercialConsents = COMMERCIAL.filter((item) => answers[item.key] !== undefined).map((item) => ({
      type: item.key,
      granted: answers[item.key] === true,
    }));

    let response: Response;
    let data: { error?: string };

    try {
      response = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: get("fullName"),
          phone: get("phone") || undefined,
          email: get("email") || undefined,
          documentNumber: get("documentNumber") || undefined,
          address: get("address") || undefined,
          notes: get("notes") || undefined,
          privacyAccepted: form.get("privacyAccepted") === "on",
          commercialConsents,
        }),
      });
      data = await response.json();
    } catch {
      // Solo un fallo de red llega aquí. Puede que el servidor sí haya guardado: se pide revisar antes de reintentar.
      setError("No se pudo confirmar el registro por un problema de conexión. Busca el cliente en la lista antes de volver a intentarlo.");
      setLoading(false);
      return;
    }

    setLoading(false);

    if (!response.ok) {
      setError(data.error || "No fue posible registrar el cliente.");
      return;
    }

    formElement.reset();
    setAnswers({});
    setOpen(false);
    router.refresh();
  }

  const inputClass = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00A651]";

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white hover:bg-[#008f45]"
      >
        + Nuevo cliente
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="grid gap-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm md:grid-cols-2">
      <h2 className="text-lg font-semibold md:col-span-2">Registrar cliente</h2>

      <label className="text-sm">
        <span className="mb-1 block font-medium text-gray-700">Nombre completo *</span>
        <input name="fullName" required minLength={2} maxLength={160} className={inputClass} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block font-medium text-gray-700">Teléfono</span>
        <input name="phone" maxLength={30} placeholder="809-555-0000" className={inputClass} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block font-medium text-gray-700">Correo</span>
        <input name="email" type="email" maxLength={254} className={inputClass} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block font-medium text-gray-700">Documento (opcional)</span>
        <input name="documentNumber" maxLength={30} className={inputClass} />
      </label>
      <label className="text-sm md:col-span-2">
        <span className="mb-1 block font-medium text-gray-700">Dirección (opcional)</span>
        <input name="address" maxLength={300} className={inputClass} />
      </label>

      <fieldset className="space-y-2 rounded-lg border border-gray-200 p-3 text-sm md:col-span-2">
        <legend className="px-1 font-medium text-gray-700">Comunicaciones comerciales (cada una se responde por separado)</legend>
        {COMMERCIAL.map((item) => (
          <div key={item.key} className="flex items-center gap-4">
            <span className="w-24">{item.label}</span>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name={item.key}
                checked={answers[item.key] === true}
                onChange={() => setAnswers((current) => ({ ...current, [item.key]: true }))}
              />
              Acepta
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name={item.key}
                checked={answers[item.key] === false}
                onChange={() => setAnswers((current) => ({ ...current, [item.key]: false }))}
              />
              No acepta
            </label>
            <label className="flex items-center gap-1 text-gray-400">
              <input
                type="radio"
                name={item.key}
                checked={answers[item.key] === undefined}
                onChange={() => setAnswers((current) => ({ ...current, [item.key]: undefined }))}
              />
              Sin respuesta
            </label>
          </div>
        ))}
      </fieldset>

      <label className="flex items-start gap-2 text-sm md:col-span-2">
        <input name="privacyAccepted" type="checkbox" required className="mt-1" />
        <span>
          El cliente fue informado del tratamiento de sus datos personales para gestionar su ficha y sus compras.
          Sus datos se usan solo para la farmacia y no se venden ni se comparten con terceros.
        </span>
      </label>

      <label className="text-sm md:col-span-2">
        <span className="mb-1 block font-medium text-gray-700">Notas internas (opcional)</span>
        <textarea name="notes" maxLength={1000} rows={2} className={inputClass} />
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-700 md:col-span-2">
          {error}
        </p>
      )}

      <div className="flex gap-2 md:col-span-2">
        <button type="submit" disabled={loading} className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
          {loading ? "Guardando..." : "Guardar cliente"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
          Cancelar
        </button>
      </div>
    </form>
  );
}
