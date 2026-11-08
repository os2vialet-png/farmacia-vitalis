"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export default function ChangePasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "No fue posible cambiar la contraseña.");
        return;
      }

      setSuccess(data.message || "Contraseña actualizada.");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");

      router.replace(data.redirectTo || "/dashboard");
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servidor. Inténtalo nuevamente.");
    } finally {
      setLoading(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 outline-none focus:border-[#00A651] focus:ring-2 focus:ring-[#00A651]/15";

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {forced && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Tu contraseña es temporal. Debes cambiarla antes de usar el sistema.
        </p>
      )}

      <div>
        <label htmlFor="current" className="mb-2 block text-sm font-medium text-gray-700">
          Contraseña actual
        </label>
        <input
          id="current"
          type="password"
          autoComplete="current-password"
          required
          maxLength={128}
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="new" className="mb-2 block text-sm font-medium text-gray-700">
          Nueva contraseña
        </label>
        <input
          id="new"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={128}
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          className={inputClass}
        />
        <p className="mt-1 text-xs text-gray-500">
          Mínimo 12 caracteres, con al menos una letra y un número. No uses tu nombre de usuario.
        </p>
      </div>

      <div>
        <label htmlFor="confirm" className="mb-2 block text-sm font-medium text-gray-700">
          Confirma la nueva contraseña
        </label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          maxLength={128}
          value={confirmPassword}
          onChange={(event) => setConfirmPassword(event.target.value)}
          className={inputClass}
        />
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {success && (
        <div role="status" className="rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {success}
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-lg bg-[#00A651] px-4 py-3 font-semibold text-white hover:bg-[#008f45] disabled:opacity-60"
      >
        {loading ? "Guardando..." : "Cambiar contraseña"}
      </button>
    </form>
  );
}
