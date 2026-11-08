export const instant = false;
import Link from "next/link";
import { db } from "@/src/lib/db";
import { requireSessionPage } from "@/src/lib/auth/page-guard";
import { navigationFor } from "@/src/lib/navigation";
import AppShell, { PharmacyCross } from "@/src/components/AppShell";
import { REPORT_TZ } from "@/src/lib/reports";

/** Fecha local (RD) de hoy y de hace n días, para el rango del gráfico de ventas. */
function localISO(afterDays: number): string {
  const now = new Date(Date.now() + afterDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: REPORT_TZ }).format(now);
}

const MODULE_EXAMPLES: Record<string, string> = {
  pos: "Registra una venta: inventario por lotes, cambio en efectivo y comprobante imprimible.",
  sales: "Revisa el historial y anula una venta autorizada: los lotes regresan.",
  customers: "Registra a un cliente y guarda sus consentimientos de contacto.",
  purchases: "Crea una orden de compra, aprueba y recibe por lote con vencimiento.",
  suppliers: "Lleva el catálogo de suplidores con los que compras la mercancía.",
  inventory: "Existencias por sucursal, reponer por el punto de pedido y ajustes auditados.",
  transfers: "Traslada mercancía entre sucursales y concilia las diferencias de recepción.",
  catalog: "Prepara cada producto: verificación, unidad de venta, precio y foto real.",
  reports: "Nueve informes con exportación a CSV desde PostgreSQL.",
  audit: "Historial inmutable de cada acción sensible con usuario e IP.",
  settings: "Textos del sistema, empleados, y la matriz de roles y permisos.",
};

function StatCard({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: "green" | "red" }) {
  return (
    <article className="rounded-xl border border-[var(--vitalis-line)] bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-[var(--vitalis-muted)]">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${accent === "red" ? "text-[var(--vitalis-red-dark)]" : "text-[var(--vitalis-green-dark)]"}`}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </article>
  );
}

function Donut({ verified, pending }: { verified: number; pending: number }) {
  const total = verified + pending;
  if (total === 0) {
    return (
      <div className="flex h-44 items-center justify-center rounded-xl border border-dashed border-gray-300 bg-white text-sm text-gray-500">
        Catálogo vacío.
      </div>
    );
  }
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const verdedshare = (verified / total) * circumference;
  const viewBox = 140;
  return (
    <figure className="flex h-44 items-center justify-center gap-6 rounded-xl border border-[var(--vitalis-line)] bg-white p-4">
      <svg viewBox={`0 0 ${viewBox} ${viewBox}`} width="140" height="140" role="img" aria-label={`Verificados ${verified} de ${total}`}>
        <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--vitalis-red-soft)" strokeWidth="16" />
        <circle
          cx="70"
          cy="70"
          r={radius}
          fill="none"
          stroke="var(--vitalis-green)"
          strokeWidth="16"
          strokeLinecap="round"
          strokeDasharray={`${verdedshare} ${circumference - verdedshare}`}
          transform="rotate(-90 70 70)"
        />
        <text x="70" y="67" textAnchor="middle" fontSize="20" fontWeight="700" fill="var(--vitalis-ink)">
          {Math.round((verified / total) * 100)}%
        </text>
        <text x="70" y="85" textAnchor="middle" fontSize="9" fill="var(--vitalis-muted)">
          verificado
        </text>
      </svg>
      <ul className="space-y-2 text-sm">
        <li className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-[var(--vitalis-green)]" aria-hidden="true"></span>
          Verificados: <strong>{verified.toLocaleString("es-DO")}</strong>
        </li>
        <li className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full bg-[var(--vitalis-red)]" aria-hidden="true"></span>
          Sin verificar: <strong>{pending.toLocaleString("es-DO")}</strong>
        </li>
        <li className="text-xs text-gray-500 max-w-40">
          El POS solo vende productos verificados. Se verifican en Catálogo → Editar.
        </li>
      </ul>
    </figure>
  );
}

function Bars({ title, rows }: { title: string; rows: { label: string; value: number; tone: string }[] }) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <figure className="rounded-xl border border-[var(--vitalis-line)] bg-white p-4">
      <figcaption className="mb-3 text-sm font-semibold text-gray-800">{title}</figcaption>
      <ul className="space-y-2.5">
        {rows.map((row) => (
          <li key={row.label} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-sm">
            <span className="w-24 shrink-0 truncate text-xs text-gray-600">{row.label}</span>
            <span className="h-2.5 overflow-hidden rounded-full bg-gray-100">
              <span
                className="block h-full rounded-full"
                style={{ width: `${(row.value / max) * 100}%`, backgroundColor: row.tone }}
                aria-hidden="true"
              />
            </span>
            <span className="w-14 text-right font-semibold tabular-nums">{row.value.toLocaleString("es-DO")}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function WeekTrend({ data }: { data: { day: string; label: string; amount: number; count: number }[] }) {
  const max = Math.max(1, ...data.map((point) => point.amount));
  return (
    <figure className="rounded-xl border border-[var(--vitalis-line)] bg-white p-4">
      <figcaption className="mb-3 text-sm font-semibold text-gray-800">Ventas — últimos 7 días</figcaption>
      <div className="flex h-28 items-end gap-1.5">
        {data.map((point) => (
          <div key={point.day} className="flex h-full flex-1 flex-col items-center justify-end gap-1" title={`${point.count} venta(s) · RD$ ${point.amount.toFixed(2)}`}>
            <div
              className="w-full rounded-t-md bg-[var(--vitalis-green)]"
              style={{ height: `${Math.max(point.amount > 0 ? 8 : 2, (point.amount / max) * 100)}%`, opacity: point.amount > 0 ? 1 : 0.25 }}
            />
          </div>
        ))}
      </div>
      <ul className="mt-2 flex gap-1.5">
        {data.map((point) => (
          <li key={point.day} className="flex-1 text-center text-[10px] uppercase text-gray-500">
            {point.label}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-gray-500">
        {data.every((point) => point.amount === 0)
          ? "Todavía no hay ventas registradas. Cada venta completada aparecerá aquí."
          : `Total de la semana: RD$ ${data.reduce((sum, point) => sum + point.amount, 0).toFixed(2)}`}
      </p>
    </figure>
  );
}

export default async function DashboardPage() {
  const session = await requireSessionPage();

  const branchesResult = await db.query<{
    id: string;
    code: string;
    name: string;
    address: string | null;
    phone: string | null;
  }>(
    `SELECT id, code, name, address, phone
     FROM farmacia.branches
     WHERE is_active = TRUE
     ORDER BY name ASC`,
  );

  const hasGlobalRole = session.roles.some((role) => role.branchId === null);
  const assignedBranchIds = new Set(
    session.roles.map((role) => role.branchId).filter((id): id is string => id !== null),
  );

  const branches = branchesResult.rows.filter(
    (branch) => hasGlobalRole || assignedBranchIds.has(branch.id),
  );
  const branchIds = branches.map((branch) => branch.id);

  const permission = (code: string) => session.roles.some((role) => role.permissions.includes(code));

  const catalogQuery = db.query<{ active: number; verified: number; with_sale_unit: number; with_brand: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE is_active)::int AS active,
       COUNT(*) FILTER (WHERE is_active AND verification_status = 'verified')::int AS verified,
       COUNT(*) FILTER (WHERE is_active AND verification_status = 'verified' AND sale_unit IS NOT NULL AND btrim(sale_unit) <> '')::int AS with_sale_unit,
       COUNT(*) FILTER (WHERE is_active AND manufacturer_id IS NOT NULL)::int AS with_brand
     FROM farmacia.catalog_products`,
  );

  const stockQuery = db.query<{ units: number; products: number }>(
    `SELECT COALESCE(SUM(s.quantity_on_hand), 0)::int AS units,
            COUNT(DISTINCT s.product_id)::int AS products
     FROM farmacia.inventory_stock s
     WHERE s.branch_id = ANY($1::uuid[])`,
    [branchIds],
  );

  const expiryQuery = db.query<{ expired: number; d30: number; d60: number; d90: number }>(
    `SELECT
       COUNT(*) FILTER (WHERE xp.day < 0)::int AS expired,
       COUNT(*) FILTER (WHERE xp.day BETWEEN 0 AND 30)::int AS d30,
       COUNT(*) FILTER (WHERE xp.day BETWEEN 31 AND 60)::int AS d60,
       COUNT(*) FILTER (WHERE xp.day BETWEEN 61 AND 90)::int AS d90
     FROM (
       SELECT (l.expiration_date - CURRENT_DATE) AS day
       FROM farmacia.inventory_lots l
       WHERE l.branch_id = ANY($1::uuid[])
         AND l.quantity_remaining > 0
         AND l.expiration_date IS NOT NULL
         AND l.status IN ('available', 'expired')
     ) xp`,
    [branchIds],
  );

  const perBranchQuery = db.query<{ id: string; name: string; units: number }>(
    `SELECT b.id, b.name, COALESCE(SUM(s.quantity_on_hand), 0)::int AS units
     FROM farmacia.branches b
     LEFT JOIN farmacia.inventory_stock s ON s.branch_id = b.id
     WHERE b.id = ANY($1::uuid[])
     GROUP BY b.id, b.name
     ORDER BY units DESC, b.name`,
    [branchIds],
  );

  const salesPermission = permission("sales.view");
  const startISO = localISO(-6);
  const endISO = localISO(0);
  const salesQuery = salesPermission
    ? db.query<{ day: string; n: number; amount: number }>(
        `SELECT to_char(s.created_at AT TIME ZONE '${REPORT_TZ}', 'YYYY-MM-DD') AS day,
                COUNT(*)::int AS n, COALESCE(SUM(s.total), 0)::float8 AS amount
         FROM farmacia.sales s
         WHERE s.branch_id = ANY($1::uuid[]) AND s.status = 'completed'
           AND s.created_at >= (($2::date)::timestamp AT TIME ZONE '${REPORT_TZ}')
           AND s.created_at < (($3::date) + 1)::timestamp AT TIME ZONE '${REPORT_TZ}'
         GROUP BY 1`,
        [branchIds, startISO, endISO],
      )
    : Promise.resolve({ rows: [] as { day: string; n: number; amount: number }[] });

  const [catalog, stock, expiry, perBranch, salesWeek] = await Promise.all([
    catalogQuery, stockQuery, expiryQuery, perBranchQuery, salesQuery,
  ]);

  // Serie de 7 días siempre completa (los días sin ventas valen 0), como pasa en los reportes.
  const salesMap = new Map(salesWeek.rows.map((row) => [row.day, row]));
  const weekData = Array.from({ length: 7 }, (_, index) => {
    const day = localISO(index - 6);
    // Mediodía UTC del mismo día local: la etiqueta sale del día ya calculado, sin leer el reloj otra vez.
    const date = new Date(`${day}T12:00:00Z`);
    const label = new Intl.DateTimeFormat("es-DO", { timeZone: REPORT_TZ, weekday: "short" }).format(date).replace(".", "");
    const found = salesMap.get(day);
    return { day, label, amount: found?.amount ?? 0, count: found?.n ?? 0 };
  });

  const hasScope = branchIds.length > 0;

  return (
    <AppShell session={session} activeItem="dashboard">
      <main className="mx-auto max-w-7xl space-y-8 p-4 md:p-8">
        <section className="overflow-hidden rounded-2xl bg-[var(--vitalis-green)] p-6 text-white shadow-sm md:p-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-white/75">Panel de la farmacia</p>
              <h2 className="mt-2 text-3xl font-bold">Bienvenido, {session.user.firstName}</h2>
              <p className="mt-2 max-w-xl text-sm text-white/85">
                Todo funciona sobre tu base PostgreSQL: catálogo del registro oficial, inventario por lotes,
                ventas, compras, transferencias y reportes. Sin datos de relleno: aquí se muestra solo lo real.
              </p>
            </div>
            <PharmacyCross className="h-16 w-16 shrink-0 drop-shadow" />
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Catálogo activo"
            value={catalog.rows[0].active.toLocaleString("es-DO")}
            hint={`${catalog.rows[0].with_brand.toLocaleString("es-DO")} con marca del registro oficial`}
          />
          <StatCard
            label="Aptos para vender"
            value={catalog.rows[0].with_sale_unit.toLocaleString("es-DO")}
            hint="Verificados y con unidad de venta; falta el precio por sucursal para el POS"
          />
          <StatCard
            label="Existencias en tus sucursales"
            value={hasScope ? stock.rows[0].units.toLocaleString("es-DO") : "0"}
            hint={hasScope ? `${stock.rows[0].products.toLocaleString("es-DO")} productos con existencia` : "Sin sucursales asignadas"}
          />
          <StatCard
            label="Próximos a vencer (60 días)"
            value={hasScope ? (expiry.rows[0].d30 + expiry.rows[0].d60).toLocaleString("es-DO") : "0"}
            hint={expiry.rows[0].expired > 0 ? `¡Atención! ${expiry.rows[0].expired} lotes ya vencidos` : "Ningún lote vencido"
            }
            accent={expiry.rows[0].expired > 0 ? "red" : undefined}
          />
        </section>

        <section className="grid gap-4 lg:grid-cols-2">
          <Donut verified={catalog.rows[0].verified} pending={catalog.rows[0].active - catalog.rows[0].verified} />
          <Bars
            title="Lotes por ventana de vencimiento"
            rows={[
              { label: "Ya vencidos", value: expiry.rows[0].expired, tone: "#b21e25" },
              { label: "0–30 días", value: expiry.rows[0].d30, tone: "var(--vitalis-red)" },
              { label: "31–60 días", value: expiry.rows[0].d60, tone: "#f0a44f" },
              { label: "61–90 días", value: expiry.rows[0].d90, tone: "var(--vitalis-green)" },
            ]}
          />
          <Bars
            title="Existencias por sucursal (unidades)"
            rows={perBranch.rows.map((row) => ({
              label: row.name,
              value: row.units,
              tone: "var(--vitalis-green)",
            }))}
          />
          {salesPermission ? (
            <WeekTrend data={weekData} />
          ) : null}
        </section>

        <section>
          <h3 className="vitalis-heading mb-3 text-lg font-semibold">Cómo arrancar con la farmacia</h3>
          <ol className="grid gap-3 rounded-xl border border-[var(--vitalis-line)] bg-white p-4 text-sm md:grid-cols-3 xl:grid-cols-5">
            {[
              { step: "1", href: "/catalogo", title: "Verifica productos", text: "En Catálogo: farmacéutico verifica cada producto con su registro y define unidad de venta." },
              { step: "2", href: "/catalogo", title: "Pon precios", text: "En Catálogo → Editar, marca el precio por sucursal (con impuesto)." },
              { step: "3", href: "/purchases", title: "Compra inventario", text: "Registra el suplidor, crea la orden, aprueba y recibe lotes con vencimiento." },
              { step: "4", href: "/pos", title: "Vende", text: "En el POS busca el producto, cobra y entrega comprobante no fiscal." },
              { step: "5", href: "/reportes", title: "Analiza", text: "Revisa ventas, existencias, rentabilidad y exporta a CSV." },
            ].map((item) => (
              <li key={item.step} className="rounded-lg bg-[var(--vitalis-green-soft)] p-3">
                <p className="mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full bg-[var(--vitalis-green)] text-xs font-bold text-white">{item.step}</p>
                <Link href={item.href} className="block font-semibold text-[var(--vitalis-green-dark)] hover:underline">{item.title}</Link>
                <p className="mt-0.5 text-xs leading-5 text-gray-600">{item.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <div>
            <h3 className="vitalis-heading mb-3 text-lg font-semibold">Sucursales</h3>
            {branches.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
                Tu cuenta no tiene sucursales asignadas. Pide al propietario que te asigne una.
              </div>
            ) : (
              <div className="grid gap-3">
                {branches.map((branch) => (
                  <article key={branch.id} className="rounded-xl border border-[var(--vitalis-line)] bg-white p-4 shadow-sm">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="rounded-full bg-[var(--vitalis-green-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--vitalis-green-dark)]">Activa</span>
                      <span className="text-xs text-gray-400">{branch.code}</span>
                    </div>
                    <h4 className="font-semibold">{branch.name}</h4>
                    <p className="mt-1 text-xs text-gray-500">{branch.address || "Dirección no registrada"}</p>
                    <p className="mt-1 text-xs text-gray-600">{branch.phone || "Teléfono no registrado"}</p>
                  </article>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="vitalis-heading mb-3 text-lg font-semibold">Módulos disponibles</h3>
            {navigationFor(session).filter((item) => item.id !== "dashboard").length === 0 ? (
              <p className="text-gray-500">Tu rol no tiene módulos asignados.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {navigationFor(session)
                  .filter((item) => item.id !== "dashboard")
                  .map((module) => (
                    <Link
                      key={module.id}
                      href={module.href}
                      className="rounded-xl border border-[var(--vitalis-line)] bg-white p-3.5 shadow-sm transition hover:border-[var(--vitalis-green)]"
                    >
                      <p className="text-sm font-semibold text-gray-900">{module.label}</p>
                      <p className="mt-1 text-xs leading-5 text-gray-500">{MODULE_EXAMPLES[module.id] ?? ""}</p>
                    </Link>
                  ))}
              </div>
            )}
          </div>
        </section>
      </main>
    </AppShell>
  );
}
