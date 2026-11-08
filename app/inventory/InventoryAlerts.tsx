"use client";

import { useCallback, useEffect, useState } from "react";

type ExpirationAlert = {
  id: string;
  lot_number: string;
  expiration_date: string;
  quantity_remaining: number | string;
  product_id: string;
  product_name: string;
  brand_name: string | null;
  alert_status: "expired" | "expiring";
  days_remaining: number;
};

type ReplenishmentAlert = {
  product_id: string;
  product_name: string;
  brand_name: string | null;
  presentation: string | null;
  sale_unit: string;
  quantity_on_hand: number | string;
  quantity_reserved: number | string;
  quantity_available: number | string;
  minimum_stock: number | string;
  maximum_stock: number | string;
  reorder_point: number | string;
};

type AlertData = {
  expirationAlerts: ExpirationAlert[];
  replenishmentAlerts: ReplenishmentAlert[];
};

type AlertSettings = Record<string, { minimumStock: string; maximumStock: string; reorderPoint: string }>;

type AlertsResult = { ok: true; data: AlertData; settings: AlertSettings } | { ok: false; error: string };

/** Consulta pura: no toca estado de React. */
async function fetchAlerts(branchId: string): Promise<AlertsResult> {
  try {
    const response = await fetch(`/api/inventory/alerts?branchId=${encodeURIComponent(branchId)}`);
    const result = await response.json();

    if (!response.ok) {
      return { ok: false, error: result.error || "No fue posible consultar las alertas." };
    }

    const settings: AlertSettings = {};
    for (const item of result.replenishmentAlerts ?? []) {
      settings[item.product_id] = {
        minimumStock: String(item.minimum_stock),
        maximumStock: String(item.maximum_stock),
        reorderPoint: String(item.reorder_point),
      };
    }

    return {
      ok: true,
      data: {
        expirationAlerts: result.expirationAlerts ?? [],
        replenishmentAlerts: result.replenishmentAlerts ?? [],
      },
      settings,
    };
  } catch {
    return { ok: false, error: "Error consultando alertas." };
  }
}

export default function InventoryAlerts({ branchId }: { branchId: string }) {
  const [data, setData] = useState<AlertData>({
    expirationAlerts: [],
    replenishmentAlerts: []
  });
  const [loading, setLoading] = useState(Boolean(branchId));
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [settings, setSettings] = useState<Record<string, {
    minimumStock: string;
    maximumStock: string;
    reorderPoint: string;
  }>>({});
  const [saving, setSaving] = useState("");

  const applyAlerts = useCallback((result: AlertsResult) => {
    if (result.ok) {
      setData(result.data);
      setSettings(result.settings);
      setError("");
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, []);

  // Recarga manual (botón y después de guardar parámetros).
  const loadAlerts = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    applyAlerts(await fetchAlerts(branchId));
  }, [branchId, applyAlerts]);

  // Carga inicial: el estado solo cambia en el callback de la respuesta; se descarta si la sucursal cambió.
  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    void fetchAlerts(branchId).then((result) => {
      if (!cancelled) applyAlerts(result);
    });
    return () => {
      cancelled = true;
    };
  }, [branchId, applyAlerts]);

  async function saveSettings(productId: string) {
    const values = settings[productId];
    if (!values) return;

    setSaving(productId);
    setError("");
    setMessage("");

    try {
      const response = await fetch("/api/inventory/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId,
          productId,
          minimumStock: Number(values.minimumStock),
          maximumStock: Number(values.maximumStock),
          reorderPoint: Number(values.reorderPoint)
        })
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "No fue posible guardar los parámetros.");
      }

      setMessage(result.message);
      await loadAlerts();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error guardando parámetros.");
    } finally {
      setSaving("");
    }
  }

  function updateSetting(
    productId: string,
    field: "minimumStock" | "maximumStock" | "reorderPoint",
    value: string
  ) {
    setSettings(current => ({
      ...current,
      [productId]: {
        ...current[productId],
        [field]: value
      }
    }));
  }

  return (
    <section className="space-y-6">
      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold">Alertas de vencimiento</h3>
            <p className="text-sm text-gray-500">
              Lotes vencidos y lotes que vencen en los próximos 30 días.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadAlerts()}
            disabled={loading}
            className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
          >
            {loading ? "Actualizando..." : "Actualizar alertas"}
          </button>
        </div>

        {data.expirationAlerts.length === 0 && !loading && (
          <p className="rounded-lg bg-gray-50 p-5 text-center text-sm text-gray-500">
            No hay lotes vencidos ni próximos a vencer.
          </p>
        )}

        <div className="space-y-2">
          {data.expirationAlerts.map(item => (
            <div
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <div>
                <p className="font-semibold">{item.product_name}</p>
                <p className="text-xs text-gray-500">
                  Lote {item.lot_number}
                  {item.brand_name ? ` · ${item.brand_name}` : ""}
                </p>
              </div>
              <div className="text-right">
                <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                  item.alert_status === "expired"
                    ? "bg-red-100 text-red-700"
                    : "bg-amber-100 text-amber-700"
                }`}>
                  {item.alert_status === "expired"
                    ? "Vencido"
                    : `Vence en ${item.days_remaining} días`}
                </span>
                <p className="mt-1 text-xs text-gray-500">
                  Vencimiento: {new Date(item.expiration_date).toLocaleDateString("es-DO")}
                  {" · "}
                  Cantidad: {Number(item.quantity_remaining)}
                </p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <h3 className="text-lg font-bold">Reposición de inventario</h3>
        <p className="mb-4 text-sm text-gray-500">
          Productos cuya existencia disponible alcanzó o bajó del punto de reposición.
        </p>

        {error && (
          <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</p>
        )}
        {message && (
          <p className="mb-4 rounded-lg bg-green-50 p-3 text-sm text-green-800">{message}</p>
        )}

        {data.replenishmentAlerts.length === 0 && !loading && (
          <p className="rounded-lg bg-gray-50 p-5 text-center text-sm text-gray-500">
            No hay productos que requieran reposición según sus parámetros actuales.
          </p>
        )}

        <div className="space-y-4">
          {data.replenishmentAlerts.map(item => {
            const values = settings[item.product_id];

            return (
              <div key={item.product_id} className="rounded-lg border p-4">
                <div className="mb-3 flex flex-wrap justify-between gap-2">
                  <div>
                    <p className="font-semibold">{item.product_name}</p>
                    <p className="text-xs text-gray-500">
                      {item.brand_name || "Sin marca"}
                      {item.presentation ? ` · ${item.presentation}` : ""}
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-amber-700">
                    Disponible: {Number(item.quantity_available)} {item.sale_unit}
                  </p>
                </div>

                {values && (
                  <>
                    <div className="grid grid-cols-3 gap-2">
                      <label className="text-xs text-gray-600">
                        Mínimo
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={values.minimumStock}
                          onChange={e => updateSetting(item.product_id, "minimumStock", e.target.value)}
                          className="mt-1 w-full rounded-lg border px-2 py-2 text-sm text-gray-900"
                        />
                      </label>
                      <label className="text-xs text-gray-600">
                        Reposición
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={values.reorderPoint}
                          onChange={e => updateSetting(item.product_id, "reorderPoint", e.target.value)}
                          className="mt-1 w-full rounded-lg border px-2 py-2 text-sm text-gray-900"
                        />
                      </label>
                      <label className="text-xs text-gray-600">
                        Máximo
                        <input
                          type="number"
                          min="0"
                          step="1"
                          value={values.maximumStock}
                          onChange={e => updateSetting(item.product_id, "maximumStock", e.target.value)}
                          className="mt-1 w-full rounded-lg border px-2 py-2 text-sm text-gray-900"
                        />
                      </label>
                    </div>

                    <button
                      type="button"
                      onClick={() => void saveSettings(item.product_id)}
                      disabled={saving === item.product_id}
                      className="mt-3 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      {saving === item.product_id ? "Guardando..." : "Guardar parámetros"}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}