
"use client";

import { useEffect, useState, FormEvent } from "react";

type Branch = {
  id: string;
  code: string;
  name: string;
};

type User = {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  must_change_password: boolean;
  created_at: string;
  roles: {
    code: string;
    name: string;
    branchId: string | null;
    branchName: string | null;
  }[];
};

type Props = {
  branches: Branch[];
  currentUser: string;
};

const roleOptions = [
  { code: "admin", name: "Administrador" },
  { code: "pharmacist", name: "Farmacéutico" },
  { code: "inventory_manager", name: "Encargado de inventario" },
  { code: "seller", name: "Vendedor" },
];

type UsersResult = { ok: true; users: User[] } | { ok: false; error: string };

/** Consulta pura: no toca estado de React. */
async function fetchUsers(): Promise<UsersResult> {
  try {
    const response = await fetch("/api/users");
    const data = await response.json();
    if (!response.ok) {
      return { ok: false, error: data.error || "No fue posible consultar los usuarios." };
    }
    return { ok: true, users: data.users };
  } catch {
    return { ok: false, error: "Error consultando usuarios." };
  }
}

export default function UsersManager({
  branches,
  currentUser,
}: Props) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");

  const [form, setForm] = useState({
    username: "",
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    branchId: branches[0]?.id || "",
    roleCode: "seller",
  });

  function applyUsers(result: UsersResult) {
    if (result.ok) {
      setUsers(result.users);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }

  // Recarga después de acciones; quien la inicia enciende el indicador si hace falta.
  async function loadUsers() {
    applyUsers(await fetchUsers());
  }

  // Carga inicial: el estado solo cambia en el callback de la respuesta.
  useEffect(() => {
    let cancelled = false;
    void fetchUsers().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setUsers(result.users);
      } else {
        setError(result.error);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function updateField(
    field: keyof typeof form,
    value: string,
  ) {
    setForm((previous) => ({
      ...previous,
      [field]: value,
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setSaving(true);
    setError("");
    setSuccess("");
    setTemporaryPassword("");

    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(form),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "No fue posible crear el empleado.");
      }

      setSuccess(data.message);
      setTemporaryPassword(data.temporaryPassword);

      setForm((previous) => ({
        ...previous,
        username: "",
        firstName: "",
        lastName: "",
        email: "",
        phone: "",
      }));

      await loadUsers();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Error creando empleado.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function copyPassword() {
    await navigator.clipboard.writeText(temporaryPassword);
    setSuccess("Contraseña temporal copiada.");
  }

  const [roleEdits, setRoleEdits] = useState<Record<string, { roleCode: string; branchId: string }>>({});
  const [busyUser, setBusyUser] = useState("");

  async function runAction(userId: string, body: Record<string, string>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;

    setBusyUser(userId);
    setError("");
    setSuccess("");
    setTemporaryPassword("");

    try {
      const response = await fetch(`/api/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "No fue posible completar la acción.");
      }

      setSuccess(data.message);
      if (data.temporaryPassword) setTemporaryPassword(data.temporaryPassword);
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error administrando el empleado.");
    } finally {
      setBusyUser("");
    }
  }

  return (
    <main className="min-h-screen bg-gray-50 p-6 text-gray-900">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-green-700">
              FARMACIA VITALIS
            </p>
            <h1 className="mt-1 text-3xl font-bold">
              Gestión de empleados
            </h1>
            <p className="mt-2 text-sm text-gray-500">
              Sesión iniciada como {currentUser}
            </p>
          </div>

          <a
            href="/dashboard"
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium hover:bg-gray-100"
          >
            Volver al panel
          </a>
        </header>

        {error && (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
            {error}
          </div>
        )}

        {success && (
          <div className="mb-5 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
            {success}
          </div>
        )}

        {temporaryPassword && (
          <section className="mb-8 rounded-xl border border-green-300 bg-white p-5">
            <h2 className="font-bold">
              Contraseña temporal
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              Entrégala al empleado de forma privada. Solo se muestra ahora.
              Tendrá que cambiarla al iniciar sesión.
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <code className="break-all rounded-lg bg-gray-100 p-3 font-mono">
                {temporaryPassword}
              </code>

              <button
                type="button"
                onClick={copyPassword}
                className="rounded-lg bg-green-700 px-4 py-3 text-sm font-semibold text-white hover:bg-green-800"
              >
                Copiar contraseña
              </button>
            </div>
          </section>
        )}

        <section className="mb-10 rounded-xl border border-gray-200 bg-white p-6">
          <h2 className="mb-6 text-xl font-bold">
            Registrar empleado
          </h2>

          {branches.length === 0 ? (
            <p className="text-sm text-red-600">
              No existen sucursales activas para asignar.
            </p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="text-sm font-medium">
                  Nombre
                  <input
                    required
                    maxLength={80}
                    value={form.firstName}
                    onChange={(e) => updateField("firstName", e.target.value)}
                    className="mt-2 w-full rounded-lg border border-gray-300 p-3"
                  />
                </label>

                <label className="text-sm font-medium">
                  Apellido
                  <input
                    required
                    maxLength={80}
                    value={form.lastName}
                    onChange={(e) => updateField("lastName", e.target.value)}
                    className="mt-2 w-full rounded-lg border border-gray-300 p-3"
                  />
                </label>

                <label className="text-sm font-medium">
                  Nombre de usuario
                  <input
                    required
                    minLength={3}
                    maxLength={40}
                    value={form.username}
                    onChange={(e) => updateField("username", e.target.value)}
                    placeholder="Ej. jperez"
                    className="mt-2 w-full rounded-lg border border-gray-300 p-3"
                  />
                </label>

                <label className="text-sm font-medium">
                  Correo electrónico (opcional)
                  <input
                    type="email"
                    maxLength={254}
                    value={form.email}
                    onChange={(e) => updateField("email", e.target.value)}
                    className="mt-2 w-full rounded-lg border border-gray-300 p-3"
                  />
                </label>

                <label className="text-sm font-medium">
                  Teléfono (opcional)
                  <input
                    maxLength={30}
                    value={form.phone}
                    onChange={(e) => updateField("phone", e.target.value)}
                    className="mt-2 w-full rounded-lg border border-gray-300 p-3"
                  />
                </label>

                <label className="text-sm font-medium">
                  Sucursal
                  <select
                    required
                    value={form.branchId}
                    onChange={(e) => updateField("branchId", e.target.value)}
                    className="mt-2 w-full rounded-lg border border-gray-300 bg-white p-3"
                  >
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name} ({branch.code})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-sm font-medium md:col-span-2">
                  Rol del empleado
                  <select
                    required
                    value={form.roleCode}
                    onChange={(e) => updateField("roleCode", e.target.value)}
                    className="mt-2 w-full rounded-lg border border-gray-300 bg-white p-3"
                  >
                    {roleOptions.map((role) => (
                      <option key={role.code} value={role.code}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <button
                type="submit"
                disabled={saving || !form.branchId}
                className="rounded-lg bg-green-700 px-6 py-3 font-semibold text-white hover:bg-green-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Creando empleado..." : "Crear empleado"}
              </button>
            </form>
          )}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-6">
          <div className="mb-5 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold">Empleados registrados</h2>
              <p className="mt-1 text-sm text-gray-500">
                {users.length} usuarios registrados
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setError("");
                void loadUsers();
              }}
              disabled={loading}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50"
            >
              Actualizar
            </button>
          </div>

          {loading ? (
            <p className="py-6 text-sm text-gray-500">
              Consultando empleados...
            </p>
          ) : users.length === 0 ? (
            <p className="py-6 text-sm text-gray-500">
              No hay empleados registrados.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b text-gray-500">
                    <th className="p-3">Empleado</th>
                    <th className="p-3">Usuario</th>
                    <th className="p-3">Rol</th>
                    <th className="p-3">Sucursal</th>
                    <th className="p-3">Estado</th>
                    <th className="p-3">Acciones</th>
                  </tr>
                </thead>

                <tbody>
                  {users.map((user) => (
                    <tr key={user.id} className="border-b last:border-0">
                      <td className="p-3">
                        <p className="font-semibold">
                          {user.first_name} {user.last_name}
                        </p>
                        <p className="text-xs text-gray-500">
                          {user.email || "Sin correo"}
                        </p>
                      </td>

                      <td className="p-3">{user.username}</td>

                      <td className="p-3">
                        {user.roles.map((role) => role.name).join(", ") || "Sin rol"}
                      </td>

                      <td className="p-3">
                        {user.roles
                          .map((role) => role.branchName || "Global")
                          .join(", ")}
                      </td>

                      <td className="p-3">
                        <span
                          className={
                            user.is_active
                              ? "rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700"
                              : "rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-700"
                          }
                        >
                          {user.is_active ? "Activo" : "Inactivo"}
                        </span>
                        {user.must_change_password && (
                          <span className="mt-1 block text-xs text-amber-700">Contraseña temporal</span>
                        )}
                      </td>

                      <td className="p-3">
                        {user.roles.some((role) => role.code === "owner") ? (
                          <span className="text-xs text-gray-400">Propietario: se gestiona por consola</span>
                        ) : (
                          <div className="space-y-2">
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={busyUser === user.id}
                                onClick={() =>
                                  runAction(
                                    user.id,
                                    { action: user.is_active ? "deactivate" : "activate" },
                                    user.is_active ? `¿Desactivar a ${user.first_name} ${user.last_name}? Sus sesiones se cerrarán.` : undefined,
                                  )
                                }
                                className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
                              >
                                {user.is_active ? "Desactivar" : "Reactivar"}
                              </button>
                              <button
                                type="button"
                                disabled={busyUser === user.id || !user.is_active}
                                onClick={() =>
                                  runAction(
                                    user.id,
                                    { action: "reset_password" },
                                    `¿Restablecer la contraseña de ${user.first_name} ${user.last_name}? Se generará una temporal.`,
                                  )
                                }
                                className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
                              >
                                Restablecer contraseña
                              </button>
                            </div>
                            <div className="flex flex-wrap items-center gap-1">
                              <select
                                aria-label="Nuevo rol"
                                value={roleEdits[user.id]?.roleCode ?? user.roles[0]?.code ?? "seller"}
                                onChange={(e) =>
                                  setRoleEdits((current) => ({
                                    ...current,
                                    [user.id]: {
                                      roleCode: e.target.value,
                                      branchId: current[user.id]?.branchId ?? user.roles[0]?.branchId ?? branches[0]?.id ?? "",
                                    },
                                  }))
                                }
                                className="rounded border border-gray-300 bg-white px-1 py-1 text-xs"
                              >
                                {roleOptions.map((role) => (
                                  <option key={role.code} value={role.code}>{role.name}</option>
                                ))}
                              </select>
                              <select
                                aria-label="Sucursal"
                                value={roleEdits[user.id]?.branchId ?? user.roles[0]?.branchId ?? branches[0]?.id ?? ""}
                                onChange={(e) =>
                                  setRoleEdits((current) => ({
                                    ...current,
                                    [user.id]: {
                                      roleCode: current[user.id]?.roleCode ?? user.roles[0]?.code ?? "seller",
                                      branchId: e.target.value,
                                    },
                                  }))
                                }
                                className="rounded border border-gray-300 bg-white px-1 py-1 text-xs"
                              >
                                {branches.map((branch) => (
                                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                                ))}
                              </select>
                              <button
                                type="button"
                                disabled={busyUser === user.id}
                                onClick={() => {
                                  const edit = roleEdits[user.id] ?? {
                                    roleCode: user.roles[0]?.code ?? "seller",
                                    branchId: user.roles[0]?.branchId ?? branches[0]?.id ?? "",
                                  };
                                  runAction(
                                    user.id,
                                    { action: "set_role", roleCode: edit.roleCode, branchId: edit.branchId },
                                    `¿Cambiar el rol de ${user.first_name} ${user.last_name}?`,
                                  );
                                }}
                                className="rounded border border-green-300 px-2 py-1 text-xs text-green-800 hover:bg-green-50 disabled:opacity-50"
                              >
                                Cambiar rol
                              </button>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
