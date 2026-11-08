import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { canOperateBranch } from "@/src/lib/access";
import { jsonError } from "@/src/lib/http";
import { loadTransferDetail, readTransferHead } from "@/src/lib/transfers";

type Context = { params: Promise<{ id: string }> };

/** Detalle de la transferencia. Visible para las sucursales origen y destino. */
export async function GET(_request: NextRequest, context: Context) {
  try {
    const access = await authorize("transfers.view");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de transferencia inválido.", 400);
    }

    const head = await readTransferHead(id);

    if (!head) {
      return jsonError("La transferencia no existe.", 404);
    }

    const canSeeOrigin = await canOperateBranch(access.session, "transfers.view", head.origin_branch_id);
    const canSeeDestination = await canOperateBranch(access.session, "transfers.view", head.destination_branch_id);

    if (!canSeeOrigin && !canSeeDestination) {
      return jsonError("No tienes acceso a esta transferencia.", 403);
    }

    const transfer = await loadTransferDetail(id);

    return NextResponse.json({ success: true, transfer });
  } catch (error) {
    console.error("Error consultando transferencia:", error);
    return jsonError("No fue posible consultar la transferencia.", 500);
  }
}
