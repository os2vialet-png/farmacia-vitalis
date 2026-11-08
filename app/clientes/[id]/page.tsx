export const instant = false;
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/src/lib/db";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import { accessibleBranchIds } from "@/src/lib/access";
import { maskDocument, CONSENT_LABELS, type ConsentType } from "@/src/lib/customers";
import AppShell from "@/src/components/AppShell";
import CustomerEditor from "./CustomerEditor";


const money = (value: string | number) =>
  new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP", minimumFractionDigits: 2 }).format(
    Number(value) || 0,
  );

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePagePermission("customers.view");
  const { id } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const customerResult = await db.query<{
    id: string;
    full_name: string;
    phone: string | null;
    email: string | null;
    document_number: string | null;
    address: string | null;
    notes: string | null;
    is_active: boolean;
    created_at: string;
  }>(
    `SELECT id, full_name, phone, email, document_number, address, notes, is_active, created_at
     FROM farmacia.customers WHERE id = $1`,
    [id],
  );

  if (customerResult.rows.length === 0) notFound();

  const customer = customerResult.rows[0];

  const consentsResult = await db.query<{ consent_type: ConsentType; granted: boolean; recorded_at: string }>(
    `SELECT DISTINCT ON (consent_type) consent_type, granted, recorded_at
     FROM farmacia.customer_consents
     WHERE customer_id = $1
     ORDER BY consent_type, recorded_at DESC, id DESC`,
    [id],
  );

  const historyResult = await db.query<{
    consent_type: ConsentType;
    granted: boolean;
    source: string;
    recorded_at: string;
    recorded_by_name: string | null;
  }>(
    `SELECT cc.consent_type, cc.granted, cc.source, cc.recorded_at,
            TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS recorded_by_name
     FROM farmacia.customer_consents cc
     LEFT JOIN farmacia.users u ON u.id = cc.recorded_by
     WHERE cc.customer_id = $1
     ORDER BY cc.recorded_at DESC, cc.id DESC
     LIMIT 30`,
    [id],
  );

  const branchIds = await accessibleBranchIds(session, "sales.view");

  const purchases = branchIds.length === 0
    ? []
    : (await db.query<{
        id: string;
        sale_number: string;
        status: string;
        total: string;
        branch_name: string;
        created_label: string;
      }>(
        `SELECT s.id, s.sale_number, s.status, s.total, b.name AS branch_name,
                to_char(s.created_at AT TIME ZONE 'America/Santo_Domingo', 'DD/MM/YYYY HH24:MI') AS created_label
         FROM farmacia.sales s
         INNER JOIN farmacia.branches b ON b.id = s.branch_id
         WHERE s.customer_id = $1 AND s.branch_id = ANY($2::uuid[])
         ORDER BY s.created_at DESC
         LIMIT 100`,
        [id, branchIds],
      )).rows;

  const canManage = session.roles.some((role) => role.permissions.includes("customers.manage"));

  const consentState = new Map(consentsResult.rows.map((row) => [row.consent_type, row.granted]));

  return (
    <AppShell session={session} activeItem="customers">
      <main className="space-y-8 p-4 md:p-8">
        <div>
          <Link href="/clientes" className="text-sm text-gray-600 hover:text-gray-900">← Volver a clientes</Link>
          <h1 className="mt-2 text-2xl font-bold text-gray-900">{customer.full_name}</h1>
          <p className="text-sm text-gray-500">
            Documento: {maskDocument(customer.document_number) ?? "No registrado"} · Registrado el{" "}
            {new Date(customer.created_at).toLocaleDateString("es-DO")}
          </p>
        </div>

        <CustomerEditor
          customer={{
            id: customer.id,
            fullName: customer.full_name,
            phone: customer.phone,
            email: customer.email,
            address: customer.address,
            notes: customer.notes,
            isActive: customer.is_active,
          }}
          canManage={canManage}
        />

        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Consentimientos</h2>
          <p className="mb-4 text-sm text-gray-500">
            Cada consentimiento es independiente. Revocar uno comercial no afecta a los demás.
          </p>
          <ul className="space-y-2 text-sm">
            {(Object.keys(CONSENT_LABELS) as ConsentType[]).map((type) => (
              <li key={type} className="flex items-center justify-between gap-4 border-b pb-2">
                <span>{CONSENT_LABELS[type]}</span>
                <span className={consentState.get(type) ? "font-medium text-green-700" : "text-gray-500"}>
                  {consentState.get(type) === undefined
                    ? "Sin respuesta"
                    : consentState.get(type)
                      ? "Autorizado"
                      : "No autorizado"}
                </span>
              </li>
            ))}
          </ul>

          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-gray-700">Historial de cambios ({historyResult.rows.length})</summary>
            <ul className="mt-2 space-y-1 text-xs text-gray-600">
              {historyResult.rows.map((row, index) => (
                <li key={index}>
                  {new Date(row.recorded_at).toLocaleString("es-DO", { timeZone: "America/Santo_Domingo" })} ·{" "}
                  {CONSENT_LABELS[row.consent_type]}: {row.granted ? "autorizado" : "revocado"} · por{" "}
                  {row.recorded_by_name ?? "sistema"} ({row.source})
                </li>
              ))}
            </ul>
          </details>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Historial de compras</h2>
          {purchases.length === 0 ? (
            <p className="mt-2 text-sm text-gray-500">Sin compras registradas en las sucursales a las que tienes acceso.</p>
          ) : (
            <table className="mt-3 w-full text-left text-sm">
              <thead className="text-xs uppercase text-gray-500">
                <tr>
                  <th className="py-2">Venta</th>
                  <th className="py-2">Fecha</th>
                  <th className="py-2">Sucursal</th>
                  <th className="py-2">Total</th>
                  <th className="py-2">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {purchases.map((sale) => (
                  <tr key={sale.id}>
                    <td className="py-2">
                      <Link href={`/ventas/${sale.id}`} className="text-green-700 hover:underline">{sale.sale_number}</Link>
                    </td>
                    <td className="py-2">{sale.created_label}</td>
                    <td className="py-2">{sale.branch_name}</td>
                    <td className="py-2">{money(sale.total)}</td>
                    <td className="py-2">{sale.status === "completed" ? "Completada" : "Anulada"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </AppShell>
  );
}
