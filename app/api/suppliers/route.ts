import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize } from "@/src/lib/auth/permissions";

const supplierSchema = z.object({
  name: z.string().trim().min(2).max(180),
  commercialName: z.string().trim().max(180).optional().nullable(),
  taxId: z.string().trim().max(40).optional().nullable(),
  contactName: z.string().trim().max(160).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  email: z.string().trim().email().max(180).optional().nullable().or(z.literal("")),
  address: z.string().trim().max(2000).optional().nullable(),
  paymentTerms: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(5000).optional().nullable(),
});

function error(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const access = await authorize("purchases.view");
    if (!access.authorized) {
      return error("No tienes autorización para consultar suplidores.", access.reason === "unauthenticated" ? 401 : 403);
    }

    const search = request.nextUrl.searchParams.get("search")?.trim() ?? "";
    const active = request.nextUrl.searchParams.get("active");

    const result = await db.query(
      `SELECT
         s.id, s.name, s.commercial_name, s.tax_id,
         s.contact_name, s.phone, s.email, s.address,
         s.payment_terms, s.notes, s.is_active,
         s.created_at, s.updated_at,
         COUNT(DISTINCT po.id)::int AS purchase_orders_count
       FROM farmacia.suppliers s
       LEFT JOIN farmacia.purchase_orders po ON po.supplier_id = s.id
       WHERE (
         $1 = ''
         OR s.name ILIKE '%' || $1 || '%'
         OR COALESCE(s.commercial_name, '') ILIKE '%' || $1 || '%'
         OR COALESCE(s.tax_id, '') ILIKE '%' || $1 || '%'
         OR COALESCE(s.contact_name, '') ILIKE '%' || $1 || '%'
       )
       AND ($2::boolean IS NULL OR s.is_active = $2)
       GROUP BY s.id
       ORDER BY s.is_active DESC, s.name ASC
       LIMIT 300`,
      [search, active === "true" ? true : active === "false" ? false : null],
    );

    return NextResponse.json({ success: true, suppliers: result.rows });
  } catch (e) {
    console.error("GET suppliers:", e);
    return error("No fue posible consultar los suplidores.", 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const access = await authorize("purchases.create");
    if (!access.authorized) {
      return error("No tienes autorización para registrar suplidores.", access.reason === "unauthenticated" ? 401 : 403);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = supplierSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json({
        success: false,
        error: "Revisa los datos del suplidor.",
        details: parsed.error.issues.map(i => ({
          field: i.path.join("."),
          message: i.message,
        })),
      }, { status: 400 });
    }

    const d = parsed.data;

    const result = await db.query(
      `INSERT INTO farmacia.suppliers (
         name, commercial_name, tax_id, contact_name, phone,
         email, address, payment_terms, notes
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        d.name, d.commercialName || null, d.taxId || null,
        d.contactName || null, d.phone || null, d.email || null,
        d.address || null, d.paymentTerms || null, d.notes || null,
      ],
    );

    const supplier = result.rows[0];

    await db.query(
      `INSERT INTO farmacia.audit_logs (
         actor_user_id, action, entity, entity_id, new_values
       ) VALUES ($1, 'supplier.create', 'supplier', $2, $3)`,
      [access.session.user.id, supplier.id, JSON.stringify({
        name: supplier.name,
        taxId: supplier.tax_id,
      })],
    );

    return NextResponse.json({ success: true, supplier }, { status: 201 });
  } catch (e) {
    const dbError = e as { code?: string };
    if (dbError.code === "23505") {
      return error("Ya existe un suplidor con esos datos únicos.", 409);
    }
    console.error("POST suppliers:", e);
    return error("No fue posible registrar el suplidor.", 500);
  }
}