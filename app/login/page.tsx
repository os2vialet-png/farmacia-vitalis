
"use client";

import { useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { PharmacyCross } from "@/src/components/AppShell";

export default function LoginPage() {
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setError("");
    setLoading(true);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "No fue posible iniciar sesión.");
        return;
      }

      router.replace(data.redirectTo || "/dashboard");
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servidor. Inténtalo nuevamente.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--vitalis-bg)] px-5 py-10">
      <div className="grid w-full max-w-5xl overflow-hidden rounded-2xl bg-white shadow-xl md:grid-cols-2">

        <section className="relative flex flex-col justify-between bg-[var(--vitalis-green)] p-8 text-white md:p-12">
          <div className="vitalis-strip absolute opacity-80" style={{ width: "100%", left: 0 }} aria-hidden="true"></div>
          <div>
            <div className="mb-12 flex items-center gap-3">
              <PharmacyCross />
              <div>
                <h1 className="text-xl font-bold tracking-wide">
                  VITALIS
                </h1>
                <p className="text-sm text-white/80">
                  Farmacia Inteligente
                </p>
              </div>
            </div>

            <p className="mb-4 text-sm font-semibold uppercase tracking-[0.2em] text-white/80">
              Plataforma de gestión
            </p>

            <h2 className="max-w-sm text-3xl font-bold leading-tight md:text-4xl">
              Todo tu negocio farmacéutico en un solo lugar.
            </h2>

            <p className="mt-6 max-w-sm text-base leading-7 text-white/85">
              Administra tus operaciones, inventario, ventas y equipo
              desde una plataforma centralizada.
            </p>
          </div>

          <p className="mt-16 text-xs text-white/70">
            © 2026 Farmacia Vitalis · <span className="text-red-200">✚</span> Atención saludable, control inteligente
          </p>
        </section>

        <section className="flex flex-col justify-center p-8 md:p-12">
          <div className="mb-8">
            <p className="text-sm font-semibold text-[var(--vitalis-red)]">
              BIENVENIDO
            </p>

            <h2 className="mt-2 text-3xl font-bold text-gray-900">
              Iniciar sesión
            </h2>

            <p className="mt-2 text-sm text-gray-500">
              Ingresa tus credenciales para acceder al sistema.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label
                htmlFor="username"
                className="mb-2 block text-sm font-medium text-gray-700"
              >
                Usuario
              </label>

              <input
                id="username"
                type="text"
                autoComplete="username"
                required
                maxLength={60}
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="Ingresa tu usuario"
                className="w-full rounded-lg border border-gray-300 px-4 py-3 text-gray-900 outline-none transition focus:border-[var(--vitalis-green)] focus:ring-2 focus:ring-[var(--vitalis-green)]/15"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-2 block text-sm font-medium text-gray-700"
              >
                Contraseña
              </label>

              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Ingresa tu contraseña"
                  className="w-full rounded-lg border border-gray-300 px-4 py-3 pr-20 text-gray-900 outline-none transition focus:border-[var(--vitalis-green)] focus:ring-2 focus:ring-[var(--vitalis-green)]/15"
                />

                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium text-gray-500 hover:text-[var(--vitalis-green-dark)]"
                >
                  {showPassword ? "Ocultar" : "Mostrar"}
                </button>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !username.trim() || !password}
              className="w-full rounded-lg bg-[var(--vitalis-green)] px-4 py-3.5 font-semibold text-white transition hover:bg-[var(--vitalis-green-dark)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? "Verificando acceso..." : "Ingresar al sistema"}
            </button>
          </form>

          <p className="mt-8 text-center text-xs text-gray-400">
            Acceso exclusivo para personal autorizado.
          </p>
        </section>
      </div>
    </main>
  );
}
