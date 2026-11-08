import { NextRequest, NextResponse , connection } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, hasPermission } from "@/src/lib/auth/permissions";

export async function GET(request: NextRequest) {
  
  await connection();
try {
    const branchId = request.nextUrl.searchParams.get("branchId");
    const search = request.nextUrl.searchParams.get("search")?.trim() ?? "";

    if (!branchId || !z.string().uuid().safeParse(branchId).success) {
      return NextResponse.json({ success: false, error: "Sucursal inválida." }, { status: 400 });
    }

    if (search.length < 2) {
      return NextResponse.json({ success: true, products: [] });
    }

    const access = await authorize("inventory.manage");
    if (!access.authorized) {
      return NextResponse.json({ success: false, error: "No autorizado." }, { status: access.reason === "unauthenticated" ? 401 : 403 });
    }

    if (!hasPermission(access.session, "inventory.manage", branchId)) {
      return NextResponse.json({ success: false, error: "No tienes acceso a esta sucursal." }, { status: 403 });
    }

    const result = await db.query(
      `SELECT id, product_name, brand_name, sanitary_registration,
              dosage_form, strength, presentation, sale_unit,
              verification_status, is_active
       FROM farmacia.catalog_products
       WHERE (
         product_name ILIKE '%' || $1 || '%'
         OR COALESCE(brand_name, '') ILIKE '%' || $1 || '%'
         OR COALESCE(sanitary_registration, '') ILIKE '%' || $1 || '%'
         OR COALESCE(barcode, '') ILIKE '%' || $1 || '%'
       )
       ORDER BY
         CASE WHEN verification_status = 'verified' THEN 0 ELSE 1 END,
         product_name
       LIMIT 30`,
      [search],
    );

    return NextResponse.json({ success: true, products: result.rows });
  } catch (error) {
    console.error("Error buscando productos para inventario:", error);
    return NextResponse.json({ success: false, error: "No fue posible buscar productos." }, { status: 500 });
  }
}