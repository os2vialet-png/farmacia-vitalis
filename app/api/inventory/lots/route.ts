import { NextRequest, NextResponse , connection } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, hasPermission } from "@/src/lib/auth/permissions";

export async function GET(request: NextRequest) {
  
  await connection();
try {
    const branchId = request.nextUrl.searchParams.get("branchId");
    const productId = request.nextUrl.searchParams.get("productId");

    if (!z.string().uuid().safeParse(branchId).success ||
        !z.string().uuid().safeParse(productId).success) {
      return NextResponse.json({ success: false, error: "Sucursal o producto inválido." }, { status: 400 });
    }

    const access = await authorize("inventory.view");
    if (!access.authorized) {
      return NextResponse.json({ success: false, error: "No autorizado." }, { status: access.reason === "unauthenticated" ? 401 : 403 });
    }

    if (!hasPermission(access.session, "inventory.view", branchId!)) {
      return NextResponse.json({ success: false, error: "No tienes acceso a esta sucursal." }, { status: 403 });
    }

    const result = await db.query(
      `SELECT id, lot_number, expiration_date, quantity_received,
              quantity_remaining, unit_cost, status, received_at
       FROM farmacia.inventory_lots
       WHERE branch_id = $1 AND product_id = $2
       ORDER BY
         CASE WHEN expiration_date IS NULL THEN 1 ELSE 0 END,
         expiration_date ASC,
         received_at ASC`,
      [branchId, productId],
    );

    return NextResponse.json({ success: true, lots: result.rows });
  } catch (error) {
    console.error("Error consultando lotes:", error);
    return NextResponse.json({ success: false, error: "No fue posible consultar los lotes." }, { status: 500 });
  }
}