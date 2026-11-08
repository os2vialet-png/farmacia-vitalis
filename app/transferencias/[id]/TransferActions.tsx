"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { MISSING_RESOLUTIONS, RESOLUTION_LABELS, type MissingResolution } from "@/src/lib/transfer-format";

type Item = { id: string; name: string; requested: number; approved: number; dispatched: number };

type Detail = { id: string; missing: number; resolution: string | null };

type Actions = { approve: boolean; dispatch: boolean; receive: boolean; cancel: boolean };

type Reconcile = { origin: boolean; destination: boolean };

/** Resoluciones que esta combinación de permisos puede decretar en destino u origen. */
function availableResolutions(reconcile: Reconcile): Array<{ value: MissingResolution; label: string }> {
  if (!reconcile.origin && !reconcile.destination) return [];
  return MISSING_RESOLUTIONS.filter(
    (resolution) =>
      (resolution === "returned" && reconcile.origin) ||
      (resolution === "found_late" && reconcile.destination) ||
      (resolution === "written_off" && (reconcile.origin || reconcile.destination)),
  ).map((resolution) => ({ value: resolution, label: RESOLUTION_LABELS[resolution] }));
}

export default function TransferActions({
  transferId,
  status,
  items,
  actions,
  reconcile = { origin: false, destination: false },
  details = [],
}: {
  transferId: string;
  status: string;
  items: Item[];
  actions: Actions;
  reconcile?: Reconcile;
  details?: Detail[];
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState<Record<string, number>>(
    Object.fromEntries(items.map((item) => [item.id, item.requested])),
  );
  const [received, setReceived] = useState<Record<string, number>>(
    Object.fromEntries(items.map((item) => [item.id, item.dispatched])),
  );
  const [discrepancy, setDiscrepancy] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [reconcileReason, setReconcileReason] = useState<Record<string, string>>({});

  async function post(path: string, body: unknown) {
    setError("");
    setBusy(true);
    try {
      const response = await fetch(`/api/transfers/${transferId}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "La operación no se completó.");
        return;
      }
      setReason("");
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servidor. Revisa el estado antes de reintentar.");
    } finally {
      setBusy(false);
    }
  }

  const inputClass = "w-28 rounded border border-gray-300 px-2 py-1 text-sm";
  const buttonClass = "rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";

  const showApprove = status === "requested" && actions.approve;
  const showDispatch = status === "approved" && actions.dispatch;
  const showReceive = status === "in_transit" && actions.receive;
  const showCancel = (status === "requested" || status === "approved") && actions.cancel;
  const showReject = status === "requested" && actions.approve;

  // Conciliación: transferencia recibida con diferencias sin cerrar y permiso de conciliación.
  const resolutionOptions = availableResolutions(reconcile);
  const pending = details.filter((detail) => detail.missing > 0 && !detail.resolution);
  const sortedPending = pending
    .slice()
    .sort((a, b) => {
      const left = items.find((item) => item.id === a.id)?.name ?? "";
      const right = items.find((item) => item.id === b.id)?.name ?? "";
      return left.localeCompare(right, "es");
    });
  const showReconcile =
    status === "received" && resolutionOptions.length > 0 && pending.length > 0;

  if (!showApprove && !showDispatch && !showReceive && !showCancel && !showReconcile) {
    return error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null;
  }

  return (
    <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold">Acciones</h2>

      {showApprove && (
        <div className="space-y-2">
          <p className="text-sm text-gray-600">Ajusta la cantidad aprobada. Puede ser menor que la solicitada.</p>
          <table className="text-sm">
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td className="py-1 pr-4">{item.name}</td>
                  <td className="py-1 pr-2 text-gray-500">Solicitado: {item.requested}</td>
                  <td className="py-1">
                    <input
                      type="number"
                      min={0}
                      max={item.requested}
                      value={approved[item.id] ?? 0}
                      onChange={(event) => setApproved((current) => ({ ...current, [item.id]: Math.floor(Number(event.target.value)) || 0 }))}
                      className={inputClass}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              post("approve", {
                items: items.map((item) => ({ itemId: item.id, quantityApproved: approved[item.id] ?? 0 })),
              })
            }
            className={`${buttonClass} bg-[#00A651] hover:bg-[#008f45]`}
          >
            Aprobar cantidades
          </button>
        </div>
      )}

      {showDispatch && (
        <div className="space-y-2">
          <p className="text-sm text-gray-600">
            Al despachar se descuenta el inventario de esta sucursal, lote por lote (primero el que vence antes).
          </p>
          <button type="button" disabled={busy} onClick={() => post("dispatch", {})} className={`${buttonClass} bg-[#00A651] hover:bg-[#008f45]`}>
            Despachar mercancía
          </button>
        </div>
      )}

      {showReceive && (
        <div className="space-y-2">
          <p className="text-sm text-gray-600">
            Indica lo que realmente llegó. Si falta algo, escribe el motivo: queda registrado en la transferencia.
          </p>
          <table className="text-sm">
            <tbody>
              {items.map((item) => {
                const quantity = received[item.id] ?? 0;
                const missing = item.dispatched - quantity;
                return (
                  <tr key={item.id} className="align-top">
                    <td className="py-1 pr-4">{item.name}<span className="block text-xs text-gray-500">Despachado: {item.dispatched}</span></td>
                    <td className="py-1 pr-2">
                      <input
                        type="number"
                        min={0}
                        max={item.dispatched}
                        value={quantity}
                        onChange={(event) => setReceived((current) => ({ ...current, [item.id]: Math.floor(Number(event.target.value)) || 0 }))}
                        className={inputClass}
                      />
                    </td>
                    <td className="py-1">
                      {missing > 0 && (
                        <input
                          type="text"
                          placeholder={`Motivo de la diferencia (${missing})`}
                          maxLength={500}
                          value={discrepancy[item.id] ?? ""}
                          onChange={(event) => setDiscrepancy((current) => ({ ...current, [item.id]: event.target.value }))}
                          className="w-72 rounded border border-gray-300 px-2 py-1 text-sm"
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              post("receive", {
                items: items.map((item) => ({
                  itemId: item.id,
                  quantityReceived: received[item.id] ?? 0,
                  discrepancyReason: discrepancy[item.id] || undefined,
                })),
              })
            }
            className={`${buttonClass} bg-[#00A651] hover:bg-[#008f45]`}
          >
            Confirmar recepción
          </button>
        </div>
      )}

      {showReconcile && (
        <div className="space-y-2 border-t pt-4">
          <p className="text-sm text-gray-600">
            Mercancía que no llegó al confirmar la recepción. Decide qué pasó: si volvió al estante de esta
            sucursal, si llegó tardíamente a destino o si se da por perdida. En los tres casos queda el
            nombre de quien decidió, la fecha y el motivo.
          </p>
          <table className="text-sm">
            <tbody>
              {sortedPending.map((detail) => {
                const item = items.find((entry) => entry.id === detail.id);
                return (
                  <tr key={detail.id} className="align-top">
                    <td className="py-1 pr-4">
                      {item?.name ?? detail.id}
                      <span className="block text-xs text-red-700">Faltan {detail.missing}</span>
                    </td>
                    <td className="py-1 pr-2">
                      <select
                        value={resolution[detail.id] ?? ""}
                        onChange={(event) => setResolution((current) => ({ ...current, [detail.id]: event.target.value }))}
                        className="rounded border border-gray-300 px-2 py-1 text-sm"
                      >
                        <option value="">¿Qué pasó?</option>
                        {resolutionOptions.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1">
                      <input
                        type="text"
                        placeholder={`Motivo (mínimo 10 caracteres)`}
                        maxLength={300}
                        value={reconcileReason[detail.id] ?? ""}
                        onChange={(event) => setReconcileReason((current) => ({ ...current, [detail.id]: event.target.value }))}
                        className="w-72 rounded border border-gray-300 px-2 py-1 text-sm"
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const payload = sortedPending.map((detail) => ({
                itemId: detail.id,
                resolution: resolution[detail.id] ?? "",
                reason: reconcileReason[detail.id] ?? "",
              }));
              const incomplete = payload.some(
                (entry) => !entry.resolution || entry.reason.trim().length < 10,
              );
              setError("");
              if (incomplete) {
                setError("Elige qué pasó con cada línea y escribe el motivo (mínimo 10 caracteres).");
                return;
              }
              post("reconcile", {
                items: payload.map((entry) => ({ itemId: entry.itemId, resolution: entry.resolution, reason: entry.reason })),
              });
            }}
            className={`${buttonClass} bg-[#00A651] hover:bg-[#008f45]`}
          >
            Registrar conciliación
          </button>
        </div>
      )}

      {(showReject || showCancel) && (
        <div className="space-y-2 border-t pt-4">
          <label className="block text-sm">
            <span className="mb-1 block text-gray-700">Motivo (obligatorio para rechazar o cancelar)</span>
            <input
              type="text"
              maxLength={300}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              className="w-full max-w-xl rounded border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {showReject && (
              <button type="button" disabled={busy || reason.trim().length < 10} onClick={() => post("reject", { reason })} className={`${buttonClass} bg-red-700 hover:bg-red-800`}>
                Rechazar solicitud
              </button>
            )}
            {showCancel && (
              <button type="button" disabled={busy || reason.trim().length < 10} onClick={() => post("cancel", { reason })} className={`${buttonClass} bg-gray-700 hover:bg-gray-800`}>
                Cancelar transferencia
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </section>
  );
}
