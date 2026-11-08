import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { canOperateBranch } from "@/src/lib/access";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { BusinessError, isBusinessError } from "@/src/lib/errors";
import { approveSchema, lockTransfer, loadTransferDetail, readTransferHead } from "@/src/lib/transfers";

type Context = { params: Promise<{ id: string }> };

/** La sucursal origen aprueba cantidades (pueden ser menores que lo solicitado). */
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
    const parsed = approveSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError("Indica la cantidad aprobada de cada producto.", 400);
    }

    const head = await readTransferHead(id);
    if (!head) return jsonError("La transferencia no existe.", 404);

    if (!(await canOperateBranch(access.session, "transfers.approve", head.origin_branch_id))) {
      return jsonError("Solo la sucursal origen puede aprobar esta transferencia.", 403);
    }

    client = await db.connect();
    await client.query("BEGIN");

    const locked = await lockTransfer(client, id);
    if (!locked) throw new BusinessError("La transferencia no existe.", 404);
    if (locked.status !== "requested") {
      throw new BusinessError(`La transferencia está en estado ${locked.status} y no se puede aprobar.`, 409);
    }

    const items = await client.query<{ id: string; quantity_requested: number }>(
      `SELECT id, quantity_requested FROM farmacia.transfer_items WHERE transfer_id = $1 FOR UPDATE`,
      [id],
    );

    const requested = new Map(items.rows.map((row) => [row.id, row.quantity_requested]));
    const provided = new Map(parsed.data.items.map((item) => [item.itemId, item.quantityApproved]));

    if (provided.size !== requested.size || [...requested.keys()].some((key) => !provided.has(key))) {
      throw new BusinessError("Debes indicar la cantidad aprobada de todos los productos.", 400);
    }

    let totalApproved = 0;

    for (const [itemId, approved] of provided) {
      const max = requested.get(itemId);
      if (max === undefined || approved > max) {
        throw new BusinessError("La cantidad aprobada no puede superar lo solicitado.", 400);
      }
      totalApproved += approved;
      await client.query(`UPDATE farmacia.transfer_items SET quantity_approved = $2 WHERE id = $1`, [itemId, approved]);
    }

    if (totalApproved === 0) {
      throw new BusinessError("Aprueba al menos una unidad, o rechaza la solicitud.", 400);
    }

    await client.query(
      `UPDATE farmacia.transfers
       SET status = 'approved', approved_by = $2, approved_at = NOW()
       WHERE id = $1`,
      [id, access.session.user.id],
    );

    await writeAudit(client, {
      actorUserId: access.session.user.id,
      branchId: head.origin_branch_id,
      action: "transfer.approve",
      entity: "transfer",
      entityId: id,
      oldValues: { status: "requested" },
      newValues: { status: "approved", totalApproved },
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
    console.error("Error aprobando transferencia:", error);
    return jsonError("No fue posible aprobar la transferencia.", 500);
  } finally {
    client?.release();
  }
}
