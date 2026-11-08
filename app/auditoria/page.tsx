export const instant = false;
import { db } from "@/src/lib/db";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import AppShell from "@/src/components/AppShell";


const TIMEZONE = "America/Santo_Domingo";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; from?: string; to?: string }>;
}) {
  const session = await requirePagePermission("audit.view");
  const params = await searchParams;

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
  const from = params.from && DATE_RE.test(params.from) ? params.from : today;
  const to = params.to && DATE_RE.test(params.to) ? params.to : today;
  const action = (params.action ?? "").trim().slice(0, 80);

  const rows = await db.query<{
    id: string;
    action: string;
    entity: string;
    entity_id: string | null;
    new_values: unknown;
    ip_address: string | null;
    actor_name: string | null;
    branch_name: string | null;
    created_label: string;
  }>(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.new_values, a.ip_address::text AS ip_address,
            TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS actor_name,
            b.name AS branch_name,
            to_char(a.created_at AT TIME ZONE '${TIMEZONE}', 'DD/MM/YYYY HH24:MI:SS') AS created_label
     FROM farmacia.audit_logs a
     LEFT JOIN farmacia.users u ON u.id = a.actor_user_id
     LEFT JOIN farmacia.branches b ON b.id = a.branch_id
     WHERE a.created_at >= ($1::date)::timestamp AT TIME ZONE '${TIMEZONE}'
       AND a.created_at < (($2::date) + 1)::timestamp AT TIME ZONE '${TIMEZONE}'
       AND ($3 = '' OR a.action ILIKE '%' || $3 || '%')
     ORDER BY a.created_at DESC
     LIMIT 500`,
    [from, to, action],
  );

  const inputClass = "rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00A651]";

  return (
    <AppShell session={session} activeItem="audit">
      <main className="space-y-6 p-4 md:p-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Auditoría</h1>
          <p className="mt-1 text-sm text-gray-500">
            Registro de operaciones sensibles. No se puede editar ni borrar desde la aplicación.
          </p>
        </div>

        <form method="get" className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium text-gray-700">Acción contiene</span>
            <input name="action" defaultValue={action} placeholder="sale, transfer, login…" className={inputClass} />
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium text-gray-700">Desde</span>
            <input type="date" name="from" defaultValue={from} className={inputClass} />
          </label>
          <label className="flex flex-col text-sm">
            <span className="mb-1 font-medium text-gray-700">Hasta</span>
            <input type="date" name="to" defaultValue={to} className={inputClass} />
          </label>
          <button type="submit" className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50">Consultar</button>
        </form>

        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[800px] text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-3">Fecha</th>
                <th className="px-3 py-3">Usuario</th>
                <th className="px-3 py-3">Sucursal</th>
                <th className="px-3 py-3">Acción</th>
                <th className="px-3 py-3">Entidad</th>
                <th className="px-3 py-3">Detalle (sin datos personales)</th>
                <th className="px-3 py-3">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-gray-500">No hay registros en este rango.</td>
                </tr>
              )}
              {rows.rows.map((row) => (
                <tr key={row.id} className="align-top">
                  <td className="px-3 py-2 whitespace-nowrap">{row.created_label}</td>
                  <td className="px-3 py-2">{row.actor_name || "Sistema / anónimo"}</td>
                  <td className="px-3 py-2">{row.branch_name ?? "—"}</td>
                  <td className="px-3 py-2 font-medium">{row.action}</td>
                  <td className="px-3 py-2">{row.entity}</td>
                  <td className="max-w-md px-3 py-2 text-xs text-gray-600 break-words">
                    {row.new_values ? JSON.stringify(row.new_values).slice(0, 220) : "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">{row.ip_address ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500">Mostrando hasta 500 registros del rango seleccionado.</p>
      </main>
    </AppShell>
  );
}
