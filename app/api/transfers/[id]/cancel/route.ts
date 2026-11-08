import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { canOperateBranch } from "@/src/lib/access";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { BusinessError, isBusinessError } from "@/src/lib/errors";
import { lockTransfer, loadTransferDetail, reasonSchema, readTransferHead } from "@/src/lib/transfers";

type Context = { params: Promise<{ id: string }> };

/**
 * Cancela una transferencia antes del despacho. Puede hacerlo la sucursal solicitante
 * (destino) o la sucursal origen. Como aún no hubo despacho, no hay inventario que revertir.
 */
export async function POST(request: NextRequest, context: Context) {
  let client;

  try {
    // Autorización amplia por sesión; el permiso real se valida por sucursal más abajo.
    const access = await authorize("transfers.view");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de transferencia inválido.", 400);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = reasonSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Motivo no válido.", 400);
    }

    const head = await readTransferHead(id);
    if (!head) return jsonError("La transferencia no existe.", 404);

    const session = access.session;
    const canAsDestination = await canOperateBranch(session, "transfers.request", head.destination_branch_id);
    const canAsOrigin = await canOperateBranch(session, "transfers.approve", head.origin_branch_id);

    if (!canAsDestination && !canAsOrigin) {
      return jsonError("No tienes permiso para cancelar esta transferencia.", 403);
    }

    client = await db.connect();
    await client.query("BEGIN");

    const locked = await lockTransfer(client, id);
    if (!locked) throw new BusinessError("La transferencia no existe.", 404);
    if (locked.status !== "requested" && locked.status !== "approved") {
      throw new BusinessError(
        `La transferencia está en estado ${locked.status}. Solo se cancelan solicitudes o aprobaciones sin despachar.`,
        409,
      );
    }

    await client.query(
      `UPDATE farmacia.transfers
       SET status = 'cancelled', cancelled_by = $2, cancelled_at = NOW(), cancel_reason = $3
       WHERE id = $1`,
      [id, session.user.id, parsed.data.reason],
    );

    await writeAudit(client, {
      actorUserId: session.user.id,
      branchId: head.destination_branch_id,
      action: "transfer.cancel",
      entity: "transfer",
      entityId: id,
      oldValues: { status: locked.status },
      newValues: { status: "cancelled", reason: parsed.data.reason },
      ip: clientIp(request),
    });

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    return NextResponse.json({ success: true, transfer: (await loadTransferDetail(id).catch(() => null)) ?? { id } });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    if (isBusinessError(error)) return jsonError(error.message, error.status);
    console.error("Error cancelando transferencia:", error);
    return jsonError("No fue posible cancelar la transferencia.", 500);
  } finally {
    client?.release();
  }
}
