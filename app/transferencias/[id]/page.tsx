export const instant = false;
import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import { canOperateBranch } from "@/src/lib/access";
import { loadTransferDetail, readTransferHead } from "@/src/lib/transfers";
import { RESOLUTION_LABELS, type MissingResolution } from "@/src/lib/transfer-format";
import AppShell from "@/src/components/AppShell";
import TransferActions from "./TransferActions";


const STATUS_LABELS: Record<string, string> = {
  requested: "Solicitada",
  approved: "Aprobada",
  in_transit: "En tránsito",
  received: "Recibida",
  rejected: "Rechazada",
  cancelled: "Cancelada",
};

export default async function TransferDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePagePermission("transfers.view");
  const { id } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const head = await readTransferHead(id);
  if (!head) notFound();

  const seesOrigin = await canOperateBranch(session, "transfers.view", head.origin_branch_id);
  const seesDestination = await canOperateBranch(session, "transfers.view", head.destination_branch_id);
  if (!seesOrigin && !seesDestination) notFound();

  const transfer = await loadTransferDetail(id);
  if (!transfer) notFound();

  const actions = {
    approve: await canOperateBranch(session, "transfers.approve", head.origin_branch_id),
    dispatch: await canOperateBranch(session, "transfers.dispatch", head.origin_branch_id),
    receive: await canOperateBranch(session, "transfers.receive", head.destination_branch_id),
    cancel:
      (await canOperateBranch(session, "transfers.request", head.destination_branch_id)) ||
      (await canOperateBranch(session, "transfers.approve", head.origin_branch_id)),
  };

  // La conciliación se opera desde la sucursal cuya mercancía asume la decisión.
  const reconcile = {
    origin: await canOperateBranch(session, "transfers.reconcile", head.origin_branch_id),
    destination: await canOperateBranch(session, "transfers.reconcile", head.destination_branch_id),
  };

  return (
    <AppShell session={session} activeItem="transfers">
      <main className="space-y-6 p-4 md:p-8">
        <div>
          <Link href="/transferencias" className="text-sm text-gray-600 hover:text-gray-900">← Volver a transferencias</Link>
          <h1 className="mt-2 text-2xl font-bold text-gray-900">{transfer.transfer_number}</h1>
          <p className="text-sm text-gray-500">
            {transfer.origin_name} → {transfer.destination_name} · Estado:{" "}
            <strong>{STATUS_LABELS[transfer.status] ?? transfer.status}</strong>
          </p>
          {transfer.notes && <p className="mt-2 text-sm text-gray-600">Notas: {transfer.notes}</p>}
          {transfer.rejection_reason && <p className="mt-2 text-sm text-red-700">Motivo de rechazo: {transfer.rejection_reason}</p>}
          {transfer.cancel_reason && <p className="mt-2 text-sm text-red-700">Motivo de cancelación: {transfer.cancel_reason}</p>}
        </div>

        <section className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-3">Producto</th>
                <th className="px-3 py-3">Solicitado</th>
                <th className="px-3 py-3">Aprobado</th>
                <th className="px-3 py-3">Despachado</th>
                <th className="px-3 py-3">Recibido</th>
                <th className="px-3 py-3">Diferencia</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {transfer.items.map((item: Record<string, unknown>) => {
                const missing = Number(item.quantity_missing);
                return (
                  <tr key={String(item.id)}>
                    <td className="px-3 py-3">
                      {String(item.product_name)}
                      {item.discrepancy_reason ? (
                        <span className="block text-xs text-red-700">{String(item.discrepancy_reason)}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-3">{String(item.quantity_requested)}</td>
                    <td className="px-3 py-3">{String(item.quantity_approved)}</td>
                    <td className="px-3 py-3">{String(item.quantity_dispatched)}</td>
                    <td className="px-3 py-3">{String(item.quantity_received)}</td>
                    <td className="px-3 py-3">
                      {missing > 0 || item.missing_resolution ? (
                        <>
                          {missing > 0 ? String(missing) : "—"}
                          {item.missing_resolution ? (
                            <span className="block text-xs text-gray-500">
                              {RESOLUTION_LABELS[String(item.missing_resolution) as MissingResolution]}
                              {item.missing_resolved_by_name ? ` · ${String(item.missing_resolved_by_name)}` : ""}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Lotes despachados</h2>
          {transfer.lots.length === 0 ? (
            <p className="mt-2 text-sm text-gray-500">Aún no hay lotes despachados.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {transfer.lots.map((lot: Record<string, unknown>, index: number) => (
                <li key={index}>
                  Lote {String(lot.lot_number ?? "sin número")} · vence {String(lot.expiration_date ?? "—")} · despachado {String(lot.quantity_dispatched)} · recibido {String(lot.quantity_received)}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* key por estado: al avanzar la transferencia, las cantidades iniciales se recalculan (p. ej., lo despachado). */}
        <TransferActions
          key={transfer.status}
          transferId={transfer.id}
          status={transfer.status}
          items={transfer.items.map((item: Record<string, unknown>) => ({
            id: String(item.id),
            name: String(item.product_name),
            requested: Number(item.quantity_requested),
            approved: Number(item.quantity_approved),
            dispatched: Number(item.quantity_dispatched),
          }))}
          actions={actions}
          reconcile={reconcile}
          details={transfer.items.map((item: Record<string, unknown>) => ({
            id: String(item.id),
            missing: Number(item.quantity_missing),
            resolution: item.missing_resolution ? String(item.missing_resolution) : null,
          }))}
        />

        <p className="text-xs text-gray-500">
          Trazabilidad: solicitó {transfer.requested_by_name}
          {transfer.approved_by_name ? ` · aprobó ${transfer.approved_by_name}` : ""}
          {transfer.dispatched_by_name ? ` · despachó ${transfer.dispatched_by_name}` : ""}
          {transfer.received_by_name ? ` · recibió ${transfer.received_by_name}` : ""}.
        </p>
      </main>
    </AppShell>
  );
}
