export const instant = false;
import Link from "next/link";
import { db } from "@/src/lib/db";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import AppShell from "@/src/components/AppShell";
import ProductImage from "@/src/components/ProductImage";
import NewProductForm from "./NewProductForm";


const FILTERS = {
  all: "Todos",
  sellable: "Vendibles",
  not_sellable: "No vendibles",
  active: "Activos",
  inactive: "Inactivos",
  pending_verification: "Sin verificar",
  verified: "Verificados",
  duplicates: "Duplicados",
} as const;

type FilterKey = keyof typeof FILTERS;

const SELLABLE_SQL = `p.is_active = TRUE AND p.verification_status = 'verified' AND p.sale_unit IS NOT NULL AND btrim(p.sale_unit) <> ''`;

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string }>;
}) {
  const session = await requirePagePermission("catalog.view");
  const canCreate = session.roles.some((role) => role.permissions.includes("catalog.create"));
  const params = await searchParams;
  const term = (params.q ?? "").trim().slice(0, 80);
  const filter: FilterKey = params.filter && params.filter in FILTERS ? (params.filter as FilterKey) : "all";

  const where = {
    all: "TRUE",
    sellable: SELLABLE_SQL,
    not_sellable: `NOT (${SELLABLE_SQL})`,
    active: "p.is_active = TRUE",
    inactive: "p.is_active = FALSE",
    pending_verification: "p.verification_status <> 'verified'",
    verified: "p.verification_status = 'verified'",
    duplicates: "p.duplicate_of_product_id IS NOT NULL",
  }[filter];

  const summary = await db.query<{
    total: number;
    active: number;
    verified: number;
    sellable: number;
    without_sale_unit: number;
    without_tax_config: number;
    duplicates: number;
  }>(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE is_active)::int AS active,
       COUNT(*) FILTER (WHERE verification_status = 'verified')::int AS verified,
       COUNT(*) FILTER (WHERE ${SELLABLE_SQL.replace(/p\./g, "")})::int AS sellable,
       COUNT(*) FILTER (WHERE sale_unit IS NULL OR btrim(sale_unit) = '')::int AS without_sale_unit,
       COUNT(*) FILTER (WHERE tax_rate IS NULL)::int AS without_tax_config,
       COUNT(*) FILTER (WHERE duplicate_of_product_id IS NOT NULL)::int AS duplicates
     FROM farmacia.catalog_products`,
  );

  const products = await db.query<{
    id: string;
    product_name: string;
    brand_name: string | null;
    manufacturer_name: string | null;
    dosage_form: string | null;
    strength: string | null;
    presentation: string | null;
    sale_unit: string | null;
    tax_rate: string | null;
    is_active: boolean;
    verification_status: string;
    is_duplicate: boolean;
    is_sellable: boolean;
    image_url: string | null;
  }>(
    `SELECT p.id, p.product_name, p.brand_name, l.name AS manufacturer_name, p.dosage_form, p.strength, p.presentation,
            p.sale_unit, p.tax_rate, p.is_active, p.verification_status, p.image_url,
            (p.duplicate_of_product_id IS NOT NULL) AS is_duplicate,
            (${SELLABLE_SQL}) AS is_sellable
     FROM farmacia.catalog_products p
     LEFT JOIN farmacia.laboratories l ON l.id = p.manufacturer_id
     WHERE ${where}
       AND ($1 = '' OR p.product_name ILIKE '%' || $1 || '%' OR COALESCE(p.brand_name, '') ILIKE '%' || $1 || '%'
            OR COALESCE(l.name, '') ILIKE '%' || $1 || '%'
            OR COALESCE(p.sanitary_registration, '') ILIKE '%' || $1 || '%' OR COALESCE(p.barcode, '') = $1)
     ORDER BY p.product_name
     LIMIT 200`,
    [term],
  );

  const s = summary.rows[0];

  return (
    <AppShell session={session} activeItem="catalog">
      <main className="space-y-6 p-4 md:p-8">
        <div>
          <h1 className="vitalis-heading text-2xl font-bold text-gray-900">Catálogo de productos</h1>
          <p className="mt-1 text-sm text-gray-500">
            Un producto se puede vender solo si está activo, verificado, con unidad de venta y precio en la sucursal.
          </p>
        </div>

        {canCreate && <NewProductForm />}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {[
            ["Total", s.total],
            ["Activos", s.active],
            ["Verificados", s.verified],
            ["Vendibles", s.sellable],
            ["Sin unidad de venta", s.without_sale_unit],
            ["Sin impuesto configurado", s.without_tax_config],
            ["Duplicados marcados", s.duplicates],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
              <p className="text-xs text-gray-500">{label}</p>
              <p className="text-xl font-bold text-gray-900">{Number(value).toLocaleString("es-DO")}</p>
            </div>
          ))}
        </div>

        <form method="get" className="flex flex-wrap items-end gap-3">
          <input
            name="q"
            defaultValue={term}
            placeholder="Nombre, marca, laboratorio, registro o código de barras"
            className="w-72 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[var(--vitalis-green)]"
          />
          <select name="filter" defaultValue={filter} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
            {(Object.keys(FILTERS) as FilterKey[]).map((key) => (
              <option key={key} value={key}>
                {FILTERS[key]}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50">
            Filtrar
          </button>
        </form>

        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead className="bg-[var(--vitalis-green-soft)] text-xs uppercase text-[var(--vitalis-green-dark)]">
              <tr>
                <th className="px-3 py-3">Producto</th>
                <th className="px-3 py-3">Marca / laboratorio</th>
                <th className="px-3 py-3">Forma / concentración</th>
                <th className="px-3 py-3">Presentación</th>
                <th className="px-3 py-3">Unidad de venta</th>
                <th className="px-3 py-3">Impuesto</th>
                <th className="px-3 py-3">Estado</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {products.rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="p-8 text-center text-gray-500">
                    No hay productos con ese criterio.
                  </td>
                </tr>
              )}
              {products.rows.map((product) => (
                <tr key={product.id} className="transition hover:bg-emerald-50/40">
                  <td className="px-3 py-3">
                    <div className="flex items-center gap-3">
                      <ProductImage
                        name={product.product_name}
                        dosageForm={product.dosage_form}
                        imageUrl={product.image_url}
                        size="sm"
                      />
                      <span className="font-medium">{product.product_name}</span>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    {product.brand_name ?? product.manufacturer_name ?? <span className="text-amber-700">Sin marca registrada</span>}
                  </td>
                  <td className="px-3 py-3">
                    {[product.dosage_form, product.strength].filter(Boolean).join(" · ") || (
                      <span className="text-amber-700">Falta concentración</span>
                    )}
                  </td>
                  <td className="px-3 py-3">{product.presentation ?? <span className="text-amber-700">Falta</span>}</td>
                  <td className="px-3 py-3">{product.sale_unit ?? <span className="text-amber-700">Falta</span>}</td>
                  <td className="px-3 py-3">
                    {product.tax_rate === null ? (
                      <span className="text-gray-500">Exento</span>
                    ) : (
                      `${(Number(product.tax_rate) * 100).toFixed(2)} %`
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-1 text-xs">
                      <span className={`rounded-full px-2 py-0.5 ${product.is_active ? "bg-[var(--vitalis-green-soft)] text-[var(--vitalis-green-dark)]" : "bg-gray-100 text-gray-600"}`}>
                        {product.is_active ? "Activo" : "Inactivo"}
                      </span>
                      <span className={`rounded-full px-2 py-0.5 ${product.verification_status === "verified" ? "bg-[var(--vitalis-green-soft)] text-[var(--vitalis-green-dark)]" : "bg-[var(--vitalis-red-soft)] text-[var(--vitalis-red-dark)]"}`}>
                        {product.verification_status === "verified" ? "Verificado" : "Sin verificar"}
                      </span>
                      {product.is_sellable && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700">Vendible</span>}
                      {product.is_duplicate && <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">Duplicado</span>}
                    </div>
                  </td>
                  <td className="px-3 py-3 text-right">
                    <Link href={`/catalogo/${product.id}`} className="font-medium text-[var(--vitalis-green-dark)] hover:underline">
                      Editar
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-500">Se muestran hasta 200 productos. Usa la búsqueda y los filtros para encontrar otros.</p>
      </main>
    </AppShell>
  );
}
