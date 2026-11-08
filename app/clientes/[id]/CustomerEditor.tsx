"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { CONSENT_LABELS, type ConsentType } from "@/src/lib/customers";

type Customer = {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
};

const COMMERCIAL: ConsentType[] = ["commercial_whatsapp", "commercial_email", "commercial_sms"];

export default function CustomerEditor({ customer, canManage }: { customer: Customer; canManage: boolean }) {
  const router = useRouter();
  const [form, setForm] = useState({
    fullName: customer.fullName,
    phone: customer.phone ?? "",
    email: customer.email ?? "",
    address: customer.address ?? "",
    notes: customer.notes ?? "",
  });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00A651] disabled:bg-gray-50";

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");
    setSaving(true);

    try {
      const response = await fetch(`/api/customers/${customer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: form.fullName,
          phone: form.phone || null,
          email: form.email || null,
          address: form.address || null,
          notes: form.notes || null,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "No fue posible guardar.");
        return;
      }
      setMessage("Datos guardados.");
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servidor.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive() {
    setError("");
    setMessage("");
    const response = await fetch(`/api/customers/${customer.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !customer.isActive }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "No fue posible cambiar el estado.");
      return;
    }
    router.refresh();
  }

  async function recordConsent(type: ConsentType, granted: boolean) {
    setError("");
    setMessage("");
    const response = await fetch(`/api/customers/${customer.id}/consents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ consentType: type, granted, source: "manual" }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "No fue posible registrar el consentimiento.");
      return;
    }
    setMessage("Consentimiento registrado.");
    router.refresh();
  }

  return (
    <section className="grid gap-6 lg:grid-cols-2">
      <form onSubmit={save} className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Datos de contacto</h2>
        {(["fullName", "phone", "email", "address"] as const).map((key) => (
          <label key={key} className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">
              {{ fullName: "Nombre", phone: "Teléfono", email: "Correo", address: "Dirección" }[key]}
            </span>
            <input
              className={inputClass}
              disabled={!canManage}
              value={form[key]}
              onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
            />
          </label>
        ))}
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-gray-700">Notas internas</span>
          <textarea
            rows={2}
            maxLength={1000}
            className={inputClass}
            disabled={!canManage}
            value={form.notes}
            onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
          />
        </label>

        {message && <p role="status" className="text-sm text-green-700">{message}</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

        {canManage && (
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={saving} className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white disabled:opacity-60">
              {saving ? "Guardando..." : "Guardar cambios"}
            </button>
            <button type="button" onClick={toggleActive} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">
              {customer.isActive ? "Desactivar cliente" : "Reactivar cliente"}
            </button>
          </div>
        )}
      </form>

      <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold">Comunicaciones comerciales</h2>
        <p className="text-sm text-gray-500">
          Registra el cambio de cada autorización. Quedan en el historial y no se borran.
        </p>
        {COMMERCIAL.map((type) => (
          <div key={type} className="flex flex-wrap items-center justify-between gap-2 border-b pb-3 text-sm">
            <span>{CONSENT_LABELS[type]}</span>
            {canManage && (
              <div className="flex gap-2">
                <button type="button" onClick={() => recordConsent(type, true)} className="rounded border border-green-300 px-2 py-1 text-green-700 hover:bg-green-50">
                  Autorizar
                </button>
                <button type="button" onClick={() => recordConsent(type, false)} className="rounded border border-gray-300 px-2 py-1 text-gray-700 hover:bg-gray-50">
                  Revocar
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
