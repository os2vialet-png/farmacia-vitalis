"use client";

import { useCallback, useEffect, useState } from "react";

type Movement = {
  id: string;
  movement_type: string;
  quantity_delta: number | string;
  unit_cost: number | string | null;
  reason: string | null;
  created_at: string;
  product_name: string;
  brand_name: string | null;
  lot_number: string | null;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
};

// Claves iguales a los tipos permitidos por la base (CHECK de inventory_movements.movement_type).
const movementLabels: Record<string, string> = {
  opening_balance: "Saldo inicial",
  purchase_receipt: "Recepción de compra",
  sale: "Venta",
  sale_return: "Anulación o devolución de venta",
  customer_return: "Devolución de cliente",
  supplier_return: "Devolución a suplidor",
  adjustment_in: "Ajuste de entrada",
  adjustment_out: "Ajuste de salida",
  transfer_in: "Entrada por transferencia",
  transfer_out: "Salida por transferencia",
  expired: "Vencimiento",
  damaged: "Merma o daño",
};

type MovementsResult = { ok: true; movements: Movement[] } | { ok: false; error: string };

/** Consulta pura: no toca estado de React. */
async function fetchMovements(branchId: string): Promise<MovementsResult> {
  try {
    const params = new URLSearchParams({ branchId });
    const response = await fetch(`/api/inventory/movements?${params}`);
    const data = await response.json();

    if (!response.ok) {
      return { ok: false, error: data.error || "No fue posible consultar los movimientos." };
    }

    return { ok: true, movements: data.movements ?? [] };
  } catch {
    return { ok: false, error: "Error consultando el historial de inventario." };
  }
}

export default function InventoryMovements({
  branchId,
}: {
  branchId: string;
}) {
  const [movements, setMovements] = useState<Movement[]>([]);
  const [loading, setLoading] = useState(Boolean(branchId));
  const [error, setError] = useState("");

  const applyMovements = useCallback((result: MovementsResult) => {
    if (result.ok) {
      setMovements(result.movements);
      setError("");
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, []);

  // Recarga manual (botón).
  const loadMovements = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    applyMovements(await fetchMovements(branchId));
  }, [branchId, applyMovements]);

  // Carga inicial: el estado solo cambia en el callback de la respuesta; se descarta si la sucursal cambió.
  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    void fetchMovements(branchId).then((result) => {
      if (!cancelled) applyMovements(result);
    });
    return () => {
      cancelled = true;
    };
  }, [branchId, applyMovements]);

  function formatDate(value: string) {
    return new Date(value).toLocaleString("es-DO", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  }

  function formatMovement(type: string) {
    return movementLabels[type] ?? type.replaceAll("_", " ");
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold">Historial de movimientos</h3>
          <p className="text-sm text-gray-500">
            Últimas 100 operaciones registradas en esta sucursal.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void loadMovements()}
          disabled={loading}
          className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? "Actualizando..." : "Actualizar historial"}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[850px] text-left text-sm">
          <thead className="border-b bg-gray-50 text-gray-500">
            <tr>
              <th className="p-3">Fecha</th>
              <th className="p-3">Producto</th>
              <th className="p-3">Operación</th>
              <th className="p-3">Cantidad</th>
              <th className="p-3">Lote</th>
              <th className="p-3">Usuario</th>
              <th className="p-3">Motivo</th>
            </tr>
          </thead>

          <tbody>
            {movements.map((movement) => {
              const quantity = Number(movement.quantity_delta);
              const userName =
                [movement.first_name, movement.last_name]
                  .filter(Boolean)
                  .join(" ") || movement.username || "Sistema";

              return (
                <tr key={movement.id} className="border-b last:border-0">
                  <td className="whitespace-nowrap p-3 text-gray-600">
                    {formatDate(movement.created_at)}
                  </td>

                  <td className="p-3">
                    <p className="font-semibold">{movement.product_name}</p>
                    <p className="text-xs text-gray-500">
                      {movement.brand_name || "Sin marca registrada"}
                    </p>
                  </td>

                  <td className="p-3">
                    {formatMovement(movement.movement_type)}
                  </td>

                  <td className="p-3">
                    <span
                      className={`font-bold ${
                        quantity > 0 ? "text-green-700" : "text-red-700"
                      }`}
                    >
                      {quantity > 0 ? "+" : ""}
                      {quantity}
                    </span>
                  </td>

                  <td className="p-3">{movement.lot_number || "—"}</td>
                  <td className="p-3">{userName}</td>
                  <td className="max-w-xs p-3 text-gray-600">
                    {movement.reason || "Sin observación"}
                  </td>
                </tr>
              );
            })}

            {!loading && movements.length === 0 && !error && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-gray-500">
                  Todavía no hay movimientos registrados en esta sucursal.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-gray-400">
        El historial muestra las operaciones registradas, no permite modificar
        movimientos anteriores.
      </p>
    </section>
  );
}