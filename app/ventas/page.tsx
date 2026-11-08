export const instant = false;
import Link from "next/link";
import { db } from "@/src/lib/db";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import { accessibleBranchIds } from "@/src/lib/access";
import AppShell from "@/src/components/AppShell";


const TIMEZONE = "America/Santo_Domingo";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const money = (value: string | number) =>
  new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP", minimumFractionDigits: 2 }).format(
    Number(value) || 0,
  );

export default async function SalesHistoryPage({
  searchParams,
}: {
  searchParams: Promise<{ branchId?: string; from?: string; to?: string; status?: string }>;
}) {
  const session = await requirePagePermission("sales.view");
  const params = await searchParams;

  const allowedIds = await accessibleBranchIds(session, "sales.view");
  const branchResult = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM farmacia.branches WHERE is_active = TRUE ORDER BY name`,
  );
  const branches = branchResult.rows.filter((branch) => allowedIds.includes(branch.id));

  const branchId = branches.some((branch) => branch.id === params.branchId)
    ? (params.branchId as string)
    : branches[0]?.id;

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
  const from = params.from && DATE_RE.test(params.from) ? params.from : today;
  const to = params.to && DATE_RE.test(params.to) ? params.to : today;
  const status = params.status === "completed" || params.status === "cancelled" ? params.status : "all";

  const sales = branchId
    ? (await db.query<{
        id: string;
        sale_number: string;
        status: string;
        total: string;
        created_at: string;
        customer_name: string | null;
        cashier_name: string;
        line_count: number;
        created_label: string;
      }>(
        `SELECT s.id, s.sale_number, s.status, s.total, s.created_at,
                c.full_name AS customer_name,
                TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS cashier_name,
                (SELECT COUNT(*)::int FROM farmacia.sale_items si WHERE si.sale_id = s.id) AS line_count,
                to_char(s.created_at AT TIME ZONE '${TIMEZONE}', 'DD/MM/YYYY HH24:MI') AS created_label
         FROM farmacia.sales s
         INNER JOIN farmacia.users u ON u.id = s.cashier_id
         LEFT JOIN farmacia.customers c ON c.id = s.customer_id
         WHERE s.branch_id = $1
           AND s.created_at >= ($2::date)::timestamp AT TIME ZONE '${TIMEZONE}'
           AND s.created_at < (($3::date) + 1)::timestamp AT TIME ZONE '${TIMEZONE}'
           AND ($4 = 'all' OR s.status = $4)
         ORDER BY s.created_at DESC
         LIMIT 300`,
        [branchId, from, to, status],
      )).rows
    : [];

  const totalSold = sales
    .filter((sale) => sale.status === "completed")
    .reduce((sum, sale) => sum + Number(sale.total), 0);

  const inputClass = "rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00A651]";

  return (
    <AppShell session={session} activeItem="sales">
      <main className="space-y-6 p-4 md:p-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Historial de ventas</h1>
          <p className="mt-1 text-sm text-gray-500">Ventas por sucursal y rango de fechas (hora de República Dominicana).</p>
        </div>

        <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium text-gray-700">Sucursal</span>
            <select name="branchId" defaultValue={branchId} className={inputClass}>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium text-gray-700">Desde</span>
            <input type="date" name="from" defaultValue={from} className={inputClass} />
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium text-gray-700">Hasta</span>
            <input type="date" name="to" defaultValue={to} className={inputClass} />
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium text-gray-700">Estado</span>
            <select name="status" defaultValue={status} className={inputClass}>
              <option value="all">Todas</option>
              <option value="completed">Completadas</option>
              <option value="cancelled">Anuladas</option>
            </select>
          </label>
          <button type="submit" className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white hover:bg-[#008f45]">
            Consultar
          </button>
          <p className="ml-auto text-sm text-gray-600">
            Vendido (completadas): <strong>{money(totalSold)}</strong>
          </p>
        </form>

        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-3">Número</th>
                <th className="px-3 py-3">Fecha</th>
                <th className="px-3 py-3">Cliente</th>
                <th className="px-3 py-3">Cajero</th>
                <th className="px-3 py-3">Líneas</th>
                <th className="px-3 py-3">Total</th>
                <th className="px-3 py-3">Estado</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {sales.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-gray-500">
                    No hay ventas en este rango.
                  </td>
                </tr>
              )}
              {sales.map((sale) => (
                <tr key={sale.id}>
                  <td className="px-3 py-3 font-semibold">{sale.sale_number}</td>
                  <td className="px-3 py-3">{sale.created_label}</td>
                  <td className="px-3 py-3">{sale.customer_name ?? "Consumidor final"}</td>
                  <td className="px-3 py-3">{sale.cashier_name}</td>
                  <td className="px-3 py-3">{sale.line_count}</td>
                  <td className="px-3 py-3 font-medium">{money(sale.total)}</td>
                  <td className="px-3 py-3">
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        sale.status === "completed" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"
                      }`}
                    >
                      {sale.status === "completed" ? "Completada" : "Anulada"}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Link href={`/ventas/${sale.id}`} className="text-green-700 hover:underline">
                      Ver
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </AppShell>
  );
}
