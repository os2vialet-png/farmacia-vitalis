"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type Setting = { key: string; value: string; description: string | null };

const LABELS: Record<string, string> = {
  pharmacy_name: "Nombre de la farmacia (comprobantes)",
  clinical_referral_text: "Texto de derivación clínica (asistentes)",
  receipt_footer: "Pie del comprobante",
};

export default function SettingsForm({ settings }: { settings: Setting[] }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(settings.map((setting) => [setting.key, setting.value])),
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");

  async function save(event: FormEvent<HTMLFormElement>, key: string) {
    event.preventDefault();
    setMessage("");
    setError("");
    setBusyKey(key);

    try {
      const response = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: values[key] }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "No fue posible guardar.");
        return;
      }
      setMessage("Configuración guardada.");
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servidor.");
    } finally {
      setBusyKey("");
    }
  }

  return (
    <div className="space-y-4">
      {message && <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      {settings.map((setting) => (
        <form key={setting.key} onSubmit={(event) => save(event, setting.key)} className="space-y-2 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">{LABELS[setting.key] ?? setting.key}</span>
            <textarea
              rows={2}
              maxLength={500}
              value={values[setting.key] ?? ""}
              onChange={(event) => setValues((current) => ({ ...current, [setting.key]: event.target.value }))}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00A651]"
            />
          </label>
          {setting.description && <p className="text-xs text-gray-500">{setting.description}</p>}
          <button
            type="submit"
            disabled={busyKey === setting.key || !(values[setting.key] ?? "").trim()}
            className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Guardar
          </button>
        </form>
      ))}
    </div>
  );
}
