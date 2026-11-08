import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { canOperateBranch } from "@/src/lib/access";
import { jsonError } from "@/src/lib/http";
import { centsToDecimal, toCents } from "@/src/lib/pos-math";

/**
 * Búsqueda para el punto de venta. Solo devuelve productos que se pueden vender:
 * activos, verificados, con unidad de venta y con precio vigente en la sucursal.
 * Incluye la cantidad vendible para que el cajero sepa si puede agregarlo.
 */
export async function GET(request: NextRequest) {
  try {
    const access = await authorize("sales.create");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const branchId = request.nextUrl.searchParams.get("branchId") ?? "";
    const term = (request.nextUrl.searchParams.get("q") ?? "").trim();

    if (!z.string().uuid().safeParse(branchId).success) {
      return jsonError("Indica una sucursal válida.", 400);
    }

    if (term.length < 2) {
      return NextResponse.json({ success: true, products: [] });
    }

    if (term.length > 80) {
      return jsonError("La búsqueda es demasiado larga.", 400);
    }

    if (!(await canOperateBranch(access.session, "sales.create", branchId))) {
      return jsonError("No tienes permiso para vender en esta sucursal.", 403);
    }

    const result = await db.query<{
      id: string;
      product_name: string;
      brand_name: string | null;
      presentation: string | null;
      sale_unit: string;
      tax_rate: string | null;
      sale_price: string;
      stock_available: string;
      lots_remaining: string;
      image_url: string | null;
    }>(
      `SELECT
         p.id,
         p.product_name,
         p.brand_name,
         l.name AS manufacturer_name,
         p.image_url,
         p.dosage_form,
         p.presentation,
         p.sale_unit,
         p.tax_rate,
         price.sale_price,
         GREATEST(0, LEAST(
           COALESCE(s.quantity_on_hand, 0) - COALESCE(s.quantity_reserved, 0),
           COALESCE(lots.remaining, 0)
         )) AS stock_available,
         COALESCE(lots.remaining, 0) AS lots_remaining
       FROM farmacia.catalog_products p
       LEFT JOIN farmacia.laboratories l ON l.id = p.manufacturer_id
       INNER JOIN LATERAL (
         SELECT pbp.sale_price
         FROM farmacia.product_branch_prices pbp
         WHERE pbp.product_id = p.id
           AND pbp.branch_id = $1
           AND pbp.effective_from <= NOW()
           AND (pbp.effective_until IS NULL OR pbp.effective_until > NOW())
         ORDER BY pbp.effective_from DESC
         LIMIT 1
       ) price ON TRUE
       LEFT JOIN farmacia.inventory_stock s
         ON s.product_id = p.id AND s.branch_id = $1
       LEFT JOIN LATERAL (
         SELECT SUM(l.quantity_remaining) AS remaining
         FROM farmacia.inventory_lots l
         WHERE l.product_id = p.id
           AND l.branch_id = $1
           AND l.status = 'available'
           AND l.quantity_remaining > 0
           AND l.expiration_date IS NOT NULL
           AND l.expiration_date >= CURRENT_DATE
       ) lots ON TRUE
       WHERE p.is_active = TRUE
         AND p.verification_status = 'verified'
         AND p.sale_unit IS NOT NULL
         AND btrim(p.sale_unit) <> ''
         AND (
           p.product_name ILIKE '%' || $2 || '%'
           OR COALESCE(p.brand_name, '') ILIKE '%' || $2 || '%'
           OR COALESCE(p.barcode, '') = $2
           OR COALESCE(p.sanitary_registration, '') ILIKE '%' || $2 || '%'
         )
       ORDER BY p.product_name
       LIMIT 30`,
      [branchId, term],
    );

    const products = result.rows
      .filter((row) => Number(row.stock_available) > 0)
      .map((row) => ({
        id: row.id,
        productName: row.product_name,
        brandName: row.brand_name,
        imageUrl: row.image_url,
        presentation: row.presentation,
        saleUnit: row.sale_unit,
        taxRate: row.tax_rate === null ? 0 : Number(row.tax_rate),
        unitPrice: centsToDecimal(toCents(row.sale_price)),
        available: Number(row.stock_available),
      }));

    return NextResponse.json({ success: true, products });
  } catch (error) {
    console.error("Error buscando productos para venta:", error);
    return jsonError("No fue posible buscar productos.", 500);
  }
}
