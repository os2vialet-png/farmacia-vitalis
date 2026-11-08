export const instant = false;
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/src/lib/db";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import { accessibleBranchIds } from "@/src/lib/access";
import AppShell from "@/src/components/AppShell";
import CatalogEditor from "./CatalogEditor";


export default async function CatalogProductPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePagePermission("catalog.view");
  const { id } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const productResult = await db.query<{
    id: string;
    product_name: string;
    brand_name: string | null;
    manufacturer_name: string | null;
    manufacturer_source: string | null;
    dosage_form: string | null;
    strength: string | null;
    presentation: string | null;
    sale_unit: string | null;
    tax_rate: string | null;
    sanitary_registration: string | null;
    is_active: boolean;
    is_prescription: boolean | null;
    is_controlled: boolean | null;
    verification_status: string;
    duplicate_of_product_id: string | null;
    image_url: string | null;
  }>(
    `SELECT p.id, p.product_name, p.brand_name,
            l.name AS manufacturer_name,
            (SELECT btrim(r.manufacturer_name) FROM farmacia.catalog_product_registrations r
             WHERE r.product_id = p.id AND btrim(r.manufacturer_name) IS NOT NULL
             ORDER BY (r.registration_status = 'VIGENTE') DESC, r.imported_at DESC LIMIT 1) AS manufacturer_source,
            p.dosage_form, p.strength, p.presentation, p.sale_unit, p.tax_rate,
            p.sanitary_registration, p.is_active, p.is_prescription, p.is_controlled,
            p.verification_status, p.duplicate_of_product_id, p.image_url
     FROM farmacia.catalog_products p
     LEFT JOIN farmacia.laboratories l ON l.id = p.manufacturer_id
     WHERE p.id = $1`,
    [id],
  );

  if (productResult.rows.length === 0) notFound();

  const product = productResult.rows[0];

  const branchIds = await accessibleBranchIds(session, "catalog.view");
  const branches = await db.query<{ id: string; name: string; current_price: string | null }>(
    `SELECT b.id, b.name,
            (SELECT pbp.sale_price FROM farmacia.product_branch_prices pbp
             WHERE pbp.product_id = $1 AND pbp.branch_id = b.id
               AND pbp.effective_from <= NOW()
               AND (pbp.effective_until IS NULL OR pbp.effective_until > NOW())
             ORDER BY pbp.effective_from DESC LIMIT 1) AS current_price
     FROM farmacia.branches b
     WHERE b.is_active = TRUE AND b.id = ANY($2::uuid[])
     ORDER BY b.name`,
    [id, branchIds],
  );

  const verifications = await db.query<{
    previous_status: string;
    new_status: string;
    evidence_type: string;
    evidence_reference: string;
    notes: string | null;
    created_label: string;
    verified_by_name: string | null;
  }>(
    `SELECT cv.previous_status, cv.new_status, cv.evidence_type, cv.evidence_reference, cv.notes,
            to_char(cv.created_at AT TIME ZONE 'America/Santo_Domingo', 'DD/MM/YYYY HH24:MI') AS created_label,
            TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS verified_by_name
     FROM farmacia.catalog_verifications cv
     LEFT JOIN farmacia.users u ON u.id = cv.verified_by
     WHERE cv.product_id = $1
     ORDER BY cv.created_at DESC
     LIMIT 20`,
    [id],
  );

  const permissions = {
    update: session.roles.some((role) => role.permissions.includes("catalog.update")),
    verify: session.roles.some((role) => role.permissions.includes("catalog.verify")),
    prices: session.roles.some((role) => role.permissions.includes("catalog.prices")),
  };

  return (
    <AppShell session={session} activeItem="catalog">
      <main className="space-y-6 p-4 md:p-8">
        <div>
          <Link href="/catalogo" className="text-sm text-gray-600 hover:text-gray-900">← Volver al catálogo</Link>
          <div className="mt-2 flex flex-wrap items-end gap-4">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">{product.product_name}</h1>
              <p className="text-sm text-gray-500">
                Registro sanitario: {product.sanitary_registration ?? "No registrado"} · Estado:{" "}
                {product.is_active ? "Activo" : "Inactivo"} ·{" "}
                <span className={product.verification_status === "verified" ? "font-medium text-[var(--vitalis-green-dark)]" : "font-medium text-[var(--vitalis-red-dark)]"}>
                  {product.verification_status === "verified" ? "Verificado" : "Sin verificar"}
                </span>
                {product.manufacturer_name ? (
                  <>
                    {" "}· Marca: <span className="font-medium text-gray-700">{product.manufacturer_name}</span>
                    {product.manufacturer_source && product.manufacturer_source !== product.manufacturer_name ? (
                      <span className="text-xs text-gray-400"> (registro oficial: {product.manufacturer_source})</span>
                    ) : null}
                  </>
                ) : (
                  <> · <span className="text-amber-700">Sin marca</span></>
                )}
              </p>
            </div>
          </div>
        </div>

        <CatalogEditor
          product={{
            id: product.id,
            name: product.product_name,
            dosageForm: product.dosage_form,
            imageUrl: product.image_url,
            brandName: product.brand_name,
            strength: product.strength,
            presentation: product.presentation,
            saleUnit: product.sale_unit,
            taxPercent: product.tax_rate === null ? null : Number((Number(product.tax_rate) * 100).toFixed(2)),
            isActive: product.is_active,
            isPrescription: product.is_prescription ?? false,
            isControlled: product.is_controlled ?? false,
            verificationStatus: product.verification_status,
            isDuplicate: product.duplicate_of_product_id !== null,
          }}
          branches={branches.rows.map((row) => ({
            id: row.id,
            name: row.name,
            currentPrice: row.current_price,
          }))}
          permissions={permissions}
        />

        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Historial de verificación</h2>
          {verifications.rows.length === 0 ? (
            <p className="mt-2 text-sm text-gray-500">Este producto aún no tiene verificaciones registradas.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {verifications.rows.map((row, index) => (
                <li key={index} className="border-b pb-2">
                  {row.created_label} · {row.previous_status} → <strong>{row.new_status}</strong> · evidencia{" "}
                  {row.evidence_type === "sanitary_registry" ? "registro sanitario" : "revisión manual"}: {row.evidence_reference}
                  {row.notes ? <span className="block text-gray-500">{row.notes}</span> : null}
                  <span className="block text-xs text-gray-400">por {row.verified_by_name ?? "sistema"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </AppShell>
  );
}
