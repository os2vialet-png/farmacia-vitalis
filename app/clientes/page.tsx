export const instant = false;
import Link from "next/link";
import { db } from "@/src/lib/db";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import { hasPermission } from "@/src/lib/auth/permissions";
import { maskDocument } from "@/src/lib/customers";
import AppShell from "@/src/components/AppShell";
import NewCustomerForm from "./NewCustomerForm";


export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await requirePagePermission("customers.view");
  const { q } = await searchParams;
  const term = (q ?? "").trim().slice(0, 80);

  const result = await db.query<{
    id: string;
    full_name: string;
    phone: string | null;
    email: string | null;
    document_number: string | null;
    is_active: boolean;
  }>(
    `SELECT id, full_name, phone, email, document_number, is_active
     FROM farmacia.customers
     WHERE ($1 = '' OR full_name ILIKE '%' || $1 || '%' OR COALESCE(phone, '') LIKE '%' || $1 || '%')
     ORDER BY full_name
     LIMIT 200`,
    [term],
  );

  const canManage = session.roles.some((role) => role.permissions.includes("customers.manage"));

  return (
    <AppShell session={session} activeItem="customers">
      <main className="space-y-6 p-4 md:p-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Clientes</h1>
            <p className="mt-1 text-sm text-gray-500">
              Solo se guarda la información necesaria. El documento se muestra enmascarado.
            </p>
          </div>
          <form method="get" className="flex gap-2">
            <input
              name="q"
              defaultValue={term}
              placeholder="Buscar por nombre o teléfono"
              className="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00A651]"
            />
            <button type="submit" className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50">
              Buscar
            </button>
          </form>
        </div>

        {canManage && <NewCustomerForm />}

        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-3">Nombre</th>
                <th className="px-3 py-3">Teléfono</th>
                <th className="px-3 py-3">Correo</th>
                <th className="px-3 py-3">Documento</th>
                <th className="px-3 py-3">Estado</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-gray-500">
                    No hay clientes que coincidan.
                  </td>
                </tr>
              )}
              {result.rows.map((customer) => (
                <tr key={customer.id}>
                  <td className="px-3 py-3 font-medium">{customer.full_name}</td>
                  <td className="px-3 py-3">{customer.phone ?? "—"}</td>
                  <td className="px-3 py-3">{customer.email ?? "—"}</td>
                  <td className="px-3 py-3">{maskDocument(customer.document_number) ?? "—"}</td>
                  <td className="px-3 py-3">{customer.is_active ? "Activo" : "Inactivo"}</td>
                  <td className="px-3 py-3 text-right">
                    <Link href={`/clientes/${customer.id}`} className="text-green-700 hover:underline">
                      Ver ficha
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {!hasPermission(session, "customers.manage") && (
          <p className="text-xs text-gray-500">Tu rol puede consultar clientes, pero no registrarlos ni editarlos.</p>
        )}
      </main>
    </AppShell>
  );
}
