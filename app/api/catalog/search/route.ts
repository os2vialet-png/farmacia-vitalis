import { NextRequest, NextResponse } from "next/server";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { jsonError } from "@/src/lib/http";

/**
 * Búsqueda de productos activos para operaciones internas (transferencias, compras).
 * No aplica la regla de verificación, que solo gobierna la venta.
 */
export async function GET(request: NextRequest) {
  try {
    const access = await authorize("catalog.view");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const term = (request.nextUrl.searchParams.get("q") ?? "").trim();

    if (term.length < 2 || term.length > 80) {
      return NextResponse.json({ success: true, products: [] });
    }

    const result = await db.query(
      `SELECT id, product_name, brand_name, presentation, sale_unit, verification_status
       FROM farmacia.catalog_products
       WHERE is_active = TRUE
         AND (
           product_name ILIKE '%' || $1 || '%'
           OR COALESCE(brand_name, '') ILIKE '%' || $1 || '%'
           OR COALESCE(sanitary_registration, '') ILIKE '%' || $1 || '%'
           OR COALESCE(barcode, '') = $1
         )
       ORDER BY product_name
       LIMIT 30`,
      [term],
    );

    return NextResponse.json({ success: true, products: result.rows });
  } catch (error) {
    console.error("Error buscando productos:", error);
    return jsonError("No fue posible buscar productos.", 500);
  }
}
