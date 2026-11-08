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

/** La sucursal origen rechaza una solicitud pendiente, con motivo. No mueve inventario. */
export async function POST(request: NextRequest, context: Context) {
  let client;

  try {
    const access = await authorize("transfers.approve");

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

    if (!(await canOperateBranch(access.session, "transfers.approve", head.origin_branch_id))) {
      return jsonError("Solo la sucursal origen puede rechazar esta transferencia.", 403);
    }

    client = await db.connect();
    await client.query("BEGIN");

    const locked = await lockTransfer(client, id);
    if (!locked) throw new BusinessError("La transferencia no existe.", 404);
    if (locked.status !== "requested") {
      throw new BusinessError(`La transferencia está en estado ${locked.status} y no se puede rechazar.`, 409);
    }

    await client.query(
      `UPDATE farmacia.transfers
       SET status = 'rejected', rejected_by = $2, rejected_at = NOW(), rejection_reason = $3
       WHERE id = $1`,
      [id, access.session.user.id, parsed.data.reason],
    );

    await writeAudit(client, {
      actorUserId: access.session.user.id,
      branchId: head.origin_branch_id,
      action: "transfer.reject",
      entity: "transfer",
      entityId: id,
      oldValues: { status: "requested" },
      newValues: { status: "rejected", reason: parsed.data.reason },
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
    console.error("Error rechazando transferencia:", error);
    return jsonError("No fue posible rechazar la transferencia.", 500);
  } finally {
    client?.release();
  }
}
