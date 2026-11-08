export const instant = false;
import { db } from "@/src/lib/db";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import { accessibleBranchIds } from "@/src/lib/access";
import AppShell from "@/src/components/AppShell";
import { REPORTS, REPORT_TZ, REPORT_COLUMNS, runReport, type ReportKey } from "@/src/lib/reports";
import { format, COLUMN_LABELS } from "@/src/lib/report-format";


const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ report?: string; branchId?: string; from?: string; to?: string; days?: string }>;
}) {
  const session = await requirePagePermission("reports.view");
  const params = await searchParams;

  const allowed = await accessibleBranchIds(session, "reports.view");
  const branchOptions = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM farmacia.branches WHERE is_active = TRUE ORDER BY name`,
  );
  const branches = branchOptions.rows.filter((branch) => allowed.includes(branch.id));

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TZ }).format(new Date());
  const monthStart = `${today.slice(0, 8)}01`;
  const from = params.from && DATE_RE.test(params.from) ? params.from : monthStart;
  const to = params.to && DATE_RE.test(params.to) ? params.to : today;
  const days = Math.min(Math.max(Number(params.days) || 60, 1), 365);
  const reportKey = (params.report && params.report in REPORTS ? params.report : "sales-by-period") as ReportKey;
  const branchId = params.branchId && branches.some((b) => b.id === params.branchId) ? params.branchId : "all";

  const rows = allowed.length === 0
    ? []
    : await runReport(reportKey, {
        branchIds: branchId === "all" ? allowed : [branchId],
        from,
        to,
        days,
      });

  const csvQuery = new URLSearchParams({
    report: reportKey,
    branchId: branchId,
    from,
    to,
    days: String(days),
    format: "csv",
  });

  const columns = REPORT_COLUMNS[reportKey];

  return (
    <AppShell session={session} activeItem="reports">
      <main className="space-y-6 p-4 md:p-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reportes</h1>
          <p className="mt-1 text-sm text-gray-500">
            Datos calculados en PostgreSQL con tus permisos. Zona horaria: República Dominicana. Solo se cuentan ventas completadas.
          </p>
        </div>

        <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium text-gray-700">Reporte</span>
            <select name="report" defaultValue={reportKey} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {(Object.keys(REPORTS) as ReportKey[]).map((key) => (
                <option key={key} value={key}>{REPORTS[key]}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium text-gray-700">Sucursal</span>
            <select name="branchId" defaultValue={branchId} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="all">Todas las sucursales</option>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium text-gray-700">Desde</span>
            <input type="date" name="from" defaultValue={from} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium text-gray-700">Hasta</span>
            <input type="date" name="to" defaultValue={to} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium text-gray-700">Días (vencimientos)</span>
            <input type="number" name="days" min={1} max={365} defaultValue={days} className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>
          <button type="submit" className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white hover:bg-[#008f45]">
            Generar
          </button>
          <a
            href={`/api/reports?${csvQuery.toString()}`}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Exportar CSV
          </a>
        </form>

        <h2 className="text-lg font-semibold">{REPORTS[reportKey]}</h2>

        {allowed.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
            Tu cuenta no tiene sucursales con acceso a reportes.
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
            No hay datos para este reporte y rango.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  {columns.map((column) => (
                    <th key={column} className="px-3 py-3">{COLUMN_LABELS[column] ?? column}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row, index) => (
                  <tr key={index}>
                    {columns.map((column) => (
                      <td key={column} className="px-3 py-2">
                        {format(column, (row as Record<string, unknown>)[column])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-xs text-gray-500">{rows.length} fila(s).</p>
      </main>
    </AppShell>
  );
}
