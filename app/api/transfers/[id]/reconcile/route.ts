import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { canOperateBranch } from "@/src/lib/access";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { BusinessError, isBusinessError } from "@/src/lib/errors";
import { lockTransfer, readTransferHead, reconcileSchema } from "@/src/lib/transfers";

type Context = { params: Promise<{ id: string }> };

type DispatchedLot = {
  id: string;
  origin_lot_id: string;
  lot_number: string | null;
  expiration_date: string | null;
  unit_cost: string | null;
  quantity_dispatched: number;
  quantity_received: number;
  destination_lot_id: string | null;
};

/**
 * Concilia las diferencias de una transferencia ya recibida.
 *
 * Deja en manos del negocio el destino de lo que no llegó:
 * - returned: vuelve al inventario de origen, lote por lote (la mercancía nunca
 *   salió físicamente de la sucursal), con movimiento de ajuste trazable.
 * - found_late: se recibe ahora en destino con la misma lógica de recepción
 *   (upsert por lote, vencimientos vigentes, movimiento transfer_in).
 * - written_off: se da por perdida; sin cambio de inventario, queda quién decidió,
 *   cuándo y el motivo.
 *
 * Cada decisión solo la puede operar una sucursal con permiso sobre la rama
 * afectada (ver transfer.reconcile en docs/PERMISOS.md). Todo corre dentro de
 * una transacción con bloqueos FOR UPDATE y queda auditado.
 */
export async function POST(request: NextRequest, context: Context) {
  let client;

  try {
    const access = await authorize("transfers.reconcile");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;

    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de transferencia inválido.", 400);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = reconcileSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError("Indica la resolución y el motivo (mínimo 10 caracteres) de cada línea.", 400);
    }

    const head = await readTransferHead(id);
    if (!head) return jsonError("La transferencia no existe.", 404);

    const session = access.session;

    client = await db.connect();
    await client.query("BEGIN");

    const locked = await lockTransfer(client, id);
    if (!locked) throw new BusinessError("La transferencia no existe.", 404);
    if (locked.status !== "received") {
      throw new BusinessError(
        `La transferencia está en estado ${locked.status}; solo se concilia una transferencia recibida.`,
        409,
      );
    }

    const items = await client.query<{
      id: string;
      product_id: string;
      product_name: string;
      quantity_missing: number;
      missing_resolution: string | null;
    }>(
      `SELECT ti.id, ti.product_id, p.product_name, ti.quantity_missing, ti.missing_resolution
       FROM farmacia.transfer_items ti
       INNER JOIN farmacia.catalog_products p ON p.id = ti.product_id
       WHERE ti.transfer_id = $1
       ORDER BY ti.id
       FOR UPDATE OF ti`,
      [id],
    );

    const requested = new Map(parsed.data.items.map((entry) => [entry.itemId, entry]));
    const origin = locked.origin_branch_id;
    const destination = locked.destination_branch_id;
    const resolutions: Array<{ itemId: string; resolution: string; quantity: number }> = [];

    for (const item of items.rows) {
      const entry = requested.get(item.id);
      if (!entry) continue;

      if (item.quantity_missing <= 0) {
        throw new BusinessError(
          `${item.product_name} no tiene diferencia pendiente de conciliar.`,
          409,
        );
      }

      if (item.missing_resolution) {
        throw new BusinessError(
          `La diferencia de ${item.product_name} ya fue conciliada. Refresca la página.`,
          409,
        );
      }

      // La decisión toca el inventario de la sucursal que la asume.
      if (entry.resolution === "returned") {
        if (!(await canOperateBranch(session, "transfers.reconcile", origin))) {
          throw new BusinessError("Solo la sucursal origen puede declarar la devolución de la mercancía.", 403);
        }

        const missing = Number(item.quantity_missing);

        // Distribución de la devolución entre los lotes despachados, en el mismo orden de la recepción.
        const lots = await client.query<DispatchedLot>(
          `SELECT id, origin_lot_id, lot_number, to_char(expiration_date, 'YYYY-MM-DD') AS expiration_date,
                  unit_cost, quantity_dispatched, quantity_received, destination_lot_id
           FROM farmacia.transfer_item_lots
           WHERE transfer_item_id = $1
           ORDER BY id`,
          [item.id],
        );

        let remaining = missing;

        for (const lot of lots.rows) {
          if (remaining <= 0) break;

          const outstanding = Number(lot.quantity_dispatched) - Number(lot.quantity_received);
          if (outstanding <= 0) continue;

          const share = Math.min(outstanding, remaining);
          remaining -= share;

          const today = await client.query<{ expired: boolean }>(
            `SELECT ($1::date < CURRENT_DATE) AS expired`,
            [lot.expiration_date],
          );

          if (today.rows[0].expired) {
            throw new BusinessError(
              `El lote ${lot.lot_number ?? ""} de ${item.product_name} ya está vencido: no se devuelve al inventario. Dala por perdida o gestiona un ajuste.`,
              409,
            );
          }

          const updated = await client.query<{ id: string }>(
            `UPDATE farmacia.inventory_lots
             SET quantity_remaining = quantity_remaining + $2,
                 status = CASE WHEN status = 'depleted' THEN 'available' ELSE status END
             WHERE id = $1
               AND status IN ('available', 'depleted')
               AND expiration_date >= CURRENT_DATE
             RETURNING id`,
            [lot.origin_lot_id, share],
          );

          if (updated.rows.length === 0) {
            throw new BusinessError(
              `El lote ${lot.lot_number ?? ""} de ${item.product_name} no está disponible en origen para devolver la mercancía. Revisa el lote antes de conciliar.`,
              409,
            );
          }

          await client.query(
            `INSERT INTO farmacia.inventory_stock (branch_id, product_id, quantity_on_hand)
             VALUES ($1, $2, $3)
             ON CONFLICT (branch_id, product_id)
             DO UPDATE SET quantity_on_hand = farmacia.inventory_stock.quantity_on_hand + EXCLUDED.quantity_on_hand,
                           updated_at = NOW()`,
            [origin, item.product_id, share],
          );

          await client.query(
            `INSERT INTO farmacia.inventory_movements (
               branch_id, product_id, lot_id, movement_type, quantity_delta,
               unit_cost, idempotency_key, reason, reference_type, reference_id, created_by
             )
             VALUES ($1, $2, $3, 'adjustment_in', $4, $5, $6, $7, 'transfer', $8, $9)`,
            [
              origin,
              item.product_id,
              lot.origin_lot_id,
              share,
              lot.unit_cost,
              `transfer-return:${lot.id}`,
              `Conciliación de ${locked.transfer_number}: mercancía devuelta a origen`,
              id,
              session.user.id,
            ],
          );
        }

        // El total devuelto debe coincidir con la diferencia declarada.
        if (remaining > 0) {
          throw new BusinessError(
            `Los lotes despachados de ${item.product_name} no explican la totalidad de la diferencia. Revisa el despacho.`,
            409,
          );
        }

        await client.query(
          `UPDATE farmacia.transfer_items
           SET missing_resolution = $2,
               missing_resolved_by = $3,
               missing_resolved_at = NOW(),
               missing_resolution_reason = $4
           WHERE id = $1`,
          [item.id, "returned", session.user.id, entry.reason],
        );

        resolutions.push({ itemId: item.id, resolution: "returned", quantity: missing });
      } else if (entry.resolution === "found_late") {
        if (!(await canOperateBranch(session, "transfers.reconcile", destination))) {
          throw new BusinessError("Solo la sucursal destino puede registrar la llegada tardía de la mercancía.", 403);
        }

        const missing = Number(item.quantity_missing);

        const lots = await client.query<DispatchedLot>(
          `SELECT id, origin_lot_id, lot_number, to_char(expiration_date, 'YYYY-MM-DD') AS expiration_date,
                  unit_cost, quantity_dispatched, quantity_received, destination_lot_id
           FROM farmacia.transfer_item_lots
           WHERE transfer_item_id = $1
           ORDER BY id`,
          [item.id],
        );

        let remaining = missing;

        for (const lot of lots.rows) {
          if (remaining <= 0) break;

          const outstanding = Number(lot.quantity_dispatched) - Number(lot.quantity_received);
          if (outstanding <= 0) continue;

          const share = Math.min(outstanding, remaining);
          remaining -= share;

          const today = await client.query<{ expired: boolean }>(
            `SELECT ($1::date < CURRENT_DATE) AS expired`,
            [lot.expiration_date],
          );

          if (today.rows[0].expired) {
            throw new BusinessError(
              `El lote ${lot.lot_number ?? ""} de ${item.product_name} está vencido y no se puede recibir.`,
              409,
            );
          }

          const upsert = await client.query<{ id: string }>(
            `INSERT INTO farmacia.inventory_lots (
               branch_id, product_id, lot_number, expiration_date,
               quantity_received, quantity_remaining, unit_cost, status, created_by, notes
             )
             VALUES ($1, $2, $3, $4, $5, $5, $6, 'available', $7, $8)
             ON CONFLICT (branch_id, product_id, lot_number)
               WHERE lot_number IS NOT NULL
             DO UPDATE SET
               quantity_received = farmacia.inventory_lots.quantity_received + EXCLUDED.quantity_received,
               quantity_remaining = farmacia.inventory_lots.quantity_remaining + EXCLUDED.quantity_remaining
             WHERE farmacia.inventory_lots.expiration_date IS NOT DISTINCT FROM EXCLUDED.expiration_date
               AND farmacia.inventory_lots.status = 'available'
               AND farmacia.inventory_lots.expiration_date >= CURRENT_DATE
             RETURNING id`,
            [
              destination,
              item.product_id,
              lot.lot_number,
              lot.expiration_date,
              share,
              lot.unit_cost,
              session.user.id,
              `Conciliación de ${locked.transfer_number}: llegada tardía`,
            ],
          );

          if (upsert.rows.length === 0) {
            throw new BusinessError(
              `El lote ${lot.lot_number ?? ""} ya existe en destino con otro vencimiento o está bloqueado. Revisa el inventario antes de conciliar.`,
              409,
            );
          }

          const destinationLotId = upsert.rows[0].id;

          await client.query(
            `UPDATE farmacia.transfer_item_lots
             SET quantity_received = quantity_received + $2, destination_lot_id = $3
             WHERE id = $1`,
            [lot.id, share, destinationLotId],
          );

          await client.query(
            `INSERT INTO farmacia.inventory_stock (branch_id, product_id, quantity_on_hand)
             VALUES ($1, $2, $3)
             ON CONFLICT (branch_id, product_id)
             DO UPDATE SET quantity_on_hand = farmacia.inventory_stock.quantity_on_hand + EXCLUDED.quantity_on_hand,
                           updated_at = NOW()`,
            [destination, item.product_id, share],
          );

          await client.query(
            `INSERT INTO farmacia.inventory_movements (
               branch_id, product_id, lot_id, movement_type, quantity_delta,
               unit_cost, idempotency_key, reason, reference_type, reference_id, created_by
             )
             VALUES ($1, $2, $3, 'transfer_in', $4, $5, $6, $7, 'transfer', $8, $9)`,
            [
              destination,
              item.product_id,
              destinationLotId,
              share,
              lot.unit_cost,
              `transfer-late:${lot.id}`,
              `Conciliación de ${locked.transfer_number}: llegada tardía en destino`,
              id,
              session.user.id,
            ],
          );
        }

        if (remaining > 0) {
          throw new BusinessError(
            `Los lotes despachados de ${item.product_name} no explican la totalidad de la diferencia. Revisa el despacho.`,
            409,
          );
        }

        // Llegada tardía = la línea termina cuadrada (recibido = despachado, diferencia en cero).
        // El descriptor de diferencia históricos se conserva aunque deje de ser una cifra abierta.
        await client.query(
          `UPDATE farmacia.transfer_items
           SET quantity_received = quantity_received + $2,
               quantity_missing = 0,
               missing_resolution = $3,
               missing_resolved_by = $4,
               missing_resolved_at = NOW(),
               missing_resolution_reason = $5
           WHERE id = $1`,
          [item.id, missing, "found_late", session.user.id, entry.reason],
        );

        resolutions.push({ itemId: item.id, resolution: "found_late", quantity: missing });
      } else if (entry.resolution === "written_off") {
        const canEither =
          (await canOperateBranch(session, "transfers.reconcile", origin)) ||
          (await canOperateBranch(session, "transfers.reconcile", destination));

        if (!canEither) {
          throw new BusinessError(
            "Para dar por perdidas la mercancía necesitas permiso de conciliación en la sucursal origen o destino.",
            403,
          );
        }

        await client.query(
          `UPDATE farmacia.transfer_items
           SET missing_resolution = $2,
               missing_resolved_by = $3,
               missing_resolved_at = NOW(),
               missing_resolution_reason = $4
           WHERE id = $1`,
          [item.id, "written_off", session.user.id, entry.reason],
        );

        resolutions.push({
          itemId: item.id,
          resolution: "written_off",
          quantity: Number(item.quantity_missing),
        });
      }
    }

    if (resolutions.length === 0) {
      throw new BusinessError(
        "Ninguna de las líneas enviadas tiene diferencia pendiente de conciliar. Refresca la página.",
        409,
      );
    }

    await writeAudit(client, {
      actorUserId: session.user.id,
      branchId: destination,
      action: "transfer.reconcile",
      entity: "transfer",
      entityId: id,
      oldValues: { status: "received" },
      newValues: { status: "received", resolutions },
      ip: clientIp(request),
    });

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    return NextResponse.json({ success: true, resolutions });
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    if (isBusinessError(error)) return jsonError(error.message, error.status);
    console.error("Error conciliando transferencia:", error);
    return jsonError("No fue posible conciliar la transferencia. Los inventarios no fueron modificados.", 500);
  } finally {
    client?.release();
  }
}
