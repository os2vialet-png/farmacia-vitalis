import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { canOperateBranch } from "@/src/lib/access";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { BusinessError, isBusinessError } from "@/src/lib/errors";
import { loadTransferDetail, transferCreateSchema } from "@/src/lib/transfers";

const TIMEZONE = "America/Santo_Domingo";

const listSchema = z.object({
  branchId: z.string().uuid(),
  direction: z.enum(["outgoing", "incoming", "all"]).default("all"),
  status: z.enum(["requested", "approved", "in_transit", "received", "rejected", "cancelled", "all"]).default("all"),
});

/** Transferencias donde la sucursal es origen o destino, según la dirección pedida. */
export async function GET(request: NextRequest) {
  try {
    const access = await authorize("transfers.view");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const params = listSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));

    if (!params.success) {
      return jsonError("Indica una sucursal válida.", 400);
    }

    const { branchId, direction, status } = params.data;

    if (!(await canOperateBranch(access.session, "transfers.view", branchId))) {
      return jsonError("No tienes acceso a las transferencias de esta sucursal.", 403);
    }

    const result = await db.query(
      `SELECT t.id, t.transfer_number, t.status, t.requested_at,
              t.origin_branch_id, ob.name AS origin_name,
              t.destination_branch_id, db.name AS destination_name,
              (SELECT COUNT(*)::int FROM farmacia.transfer_items ti WHERE ti.transfer_id = t.id) AS item_count,
              to_char(t.requested_at AT TIME ZONE '${TIMEZONE}', 'DD/MM/YYYY HH24:MI') AS requested_label
       FROM farmacia.transfers t
       INNER JOIN farmacia.branches ob ON ob.id = t.origin_branch_id
       INNER JOIN farmacia.branches db ON db.id = t.destination_branch_id
       WHERE (
         ($2 = 'outgoing' AND t.origin_branch_id = $1)
         OR ($2 = 'incoming' AND t.destination_branch_id = $1)
         OR ($2 = 'all' AND (t.origin_branch_id = $1 OR t.destination_branch_id = $1))
       )
         AND ($3 = 'all' OR t.status = $3)
       ORDER BY t.requested_at DESC
       LIMIT 200`,
      [branchId, direction, status],
    );

    return NextResponse.json({ success: true, transfers: result.rows });
  } catch (error) {
    console.error("Error listando transferencias:", error);
    return jsonError("No fue posible consultar las transferencias.", 500);
  }
}

/** Crea una solicitud. La sucursal que solicita es la destino: pide mercancía a la sucursal origen. */
export async function POST(request: NextRequest) {
  let client;

  try {
    const access = await authorize("transfers.request");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = transferCreateSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Datos de la solicitud no válidos.", 400);
    }

    const data = parsed.data;

    if (data.originBranchId === data.destinationBranchId) {
      return jsonError("La sucursal origen y la destino deben ser diferentes.", 400);
    }

    const productIds = data.items.map((item) => item.productId);
    if (new Set(productIds).size !== productIds.length) {
      return jsonError("Un producto no puede aparecer dos veces en la misma solicitud.", 400);
    }

    if (!(await canOperateBranch(access.session, "transfers.request", data.destinationBranchId))) {
      return jsonError("No tienes permiso para solicitar mercancía para esta sucursal.", 403);
    }

    client = await db.connect();
    await client.query("BEGIN");

    const branches = await client.query(
      `SELECT id FROM farmacia.branches WHERE id = ANY($1::uuid[]) AND is_active = TRUE FOR SHARE`,
      [[data.originBranchId, data.destinationBranchId]],
    );

    if (branches.rows.length !== 2) {
      throw new BusinessError("Una de las sucursales no existe o está inactiva.", 404);
    }

    const products = await client.query(
      `SELECT id, product_name FROM farmacia.catalog_products
       WHERE id = ANY($1::uuid[]) AND is_active = TRUE FOR SHARE`,
      [productIds],
    );

    if (products.rows.length !== productIds.length) {
      throw new BusinessError("Uno o más productos no existen o están inactivos.", 409);
    }

    const sequence = await client.query<{ day: string; n: string }>(
      `SELECT to_char(NOW() AT TIME ZONE '${TIMEZONE}', 'YYYYMMDD') AS day,
              nextval('farmacia.transfer_number_seq') AS n`,
    );
    const transferNumber = `TRF-${sequence.rows[0].day}-${String(sequence.rows[0].n).padStart(6, "0")}`;

    const created = await client.query<{ id: string }>(
      `INSERT INTO farmacia.transfers
         (transfer_number, origin_branch_id, destination_branch_id, status, notes, requested_by)
       VALUES ($1, $2, $3, 'requested', $4, $5)
       RETURNING id`,
      [transferNumber, data.originBranchId, data.destinationBranchId, data.notes || null, access.session.user.id],
    );

    const transferId = created.rows[0].id;

    for (const item of data.items) {
      await client.query(
        `INSERT INTO farmacia.transfer_items (transfer_id, product_id, quantity_requested)
         VALUES ($1, $2, $3)`,
        [transferId, item.productId, item.quantity],
      );
    }

    await writeAudit(client, {
      actorUserId: access.session.user.id,
      branchId: data.destinationBranchId,
      action: "transfer.request",
      entity: "transfer",
      entityId: transferId,
      newValues: {
        transferNumber,
        originBranchId: data.originBranchId,
        items: data.items,
      },
      ip: clientIp(request),
    });

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    const transfer = (await loadTransferDetail(transferId).catch(() => null)) ?? { id: transferId };
    return NextResponse.json({ success: true, transfer }, { status: 201 });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    if (isBusinessError(error)) {
      return jsonError(error.message, error.status);
    }
    console.error("Error creando transferencia:", error);
    return jsonError("No fue posible crear la solicitud.", 500);
  } finally {
    client?.release();
  }
}
