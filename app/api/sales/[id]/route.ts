import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { canOperateBranch } from "@/src/lib/access";
import { jsonError } from "@/src/lib/http";
import { loadSaleDetail } from "@/src/lib/sales";
import { db } from "@/src/lib/db";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  try {
    const access = await authorize("sales.view");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de venta inválido.", 400);
    }

    const head = await db.query<{ branch_id: string }>(
      `SELECT branch_id FROM farmacia.sales WHERE id = $1`,
      [id],
    );

    if (head.rows.length === 0) {
      return jsonError("La venta no existe.", 404);
    }

    if (!(await canOperateBranch(access.session, "sales.view", head.rows[0].branch_id))) {
      return jsonError("No tienes acceso a esta venta.", 403);
    }

    const sale = await loadSaleDetail(id);

    return NextResponse.json({ success: true, sale });
  } catch (error) {
    console.error("Error consultando venta:", error);
    return jsonError("No fue posible consultar la venta.", 500);
  }
}
