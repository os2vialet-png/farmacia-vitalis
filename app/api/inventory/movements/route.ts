import { NextRequest, NextResponse , connection } from "next/server";
import { z } from "zod";

import { db } from "@/src/lib/db";
import { authorize, hasPermission } from "@/src/lib/auth/permissions";

export async function GET(request: NextRequest) {
  
  await connection();
try {
    const branchId = request.nextUrl.searchParams.get("branchId");

    if (!branchId || !z.string().uuid().safeParse(branchId).success) {
      return NextResponse.json(
        { error: "Debes indicar una sucursal válida." },
        { status: 400 },
      );
    }

    const access = await authorize("inventory.view");

    if (!access.authorized) {
      return NextResponse.json(
        { error: "No tienes autorización." },
        { status: access.reason === "unauthenticated" ? 401 : 403 },
      );
    }

    if (!hasPermission(access.session, "inventory.view", branchId)) {
      return NextResponse.json(
        { error: "No tienes acceso a esta sucursal." },
        { status: 403 },
      );
    }

    const result = await db.query(
      `SELECT
         m.id,
         m.movement_type,
         m.quantity_delta,
         m.unit_cost,
         m.reason,
         m.created_at,
         p.product_name,
         p.brand_name,
         l.lot_number,
         u.username,
         u.first_name,
         u.last_name
       FROM farmacia.inventory_movements m
       INNER JOIN farmacia.catalog_products p ON p.id = m.product_id
       LEFT JOIN farmacia.inventory_lots l ON l.id = m.lot_id
       LEFT JOIN farmacia.users u ON u.id = m.created_by
       WHERE m.branch_id = $1
       ORDER BY m.created_at DESC
       LIMIT 100`,
      [branchId],
    );

    return NextResponse.json({
      success: true,
      total: result.rows.length,
      movements: result.rows,
    });
  } catch (error) {
    console.error("Error consultando movimientos:", error);

    return NextResponse.json(
      { error: "No fue posible consultar los movimientos." },
      { status: 500 },
    );
  }
}