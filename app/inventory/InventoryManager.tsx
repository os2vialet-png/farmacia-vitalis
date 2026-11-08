"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import InventoryMovements from "./InventoryMovements";
import InventoryAlerts from "./InventoryAlerts";

type Branch = { id: string; code: string; name: string };
type Product = {
  id: string;
  product_name: string;
  brand_name: string | null;
  sanitary_registration: string | null;
  dosage_form: string | null;
  strength: string | null;
  presentation: string | null;
  sale_unit: string;
  verification_status: string;
  is_active: boolean;
};
type Stock = {
  product_id: string;
  product_name: string;
  brand_name: string | null;
  dosage_form: string | null;
  strength: string | null;
  presentation: string | null;
  sale_unit: string;
  quantity_on_hand: number;
  quantity_reserved: number;
  quantity_available: number;
  minimum_stock: number;
  maximum_stock: number;
  reorder_point: number;
  stock_status: string;
};
type Lot = {
  id: string;
  lot_number: string;
  expiration_date: string | null;
  quantity_remaining: number;
  status: string;
};

type StockResult = { ok: true; stock: Stock[] } | { ok: false; error: string };

/** Consulta pura: no toca estado de React. */
async function fetchStock(branchId: string, search: string): Promise<StockResult> {
  try {
    const params = new URLSearchParams({ branchId, search });
    const response = await fetch(`/api/inventory?${params}`);
    const data = await response.json();
    if (!response.ok) return { ok: false, error: data.error || "Error consultando inventario." };
    return { ok: true, stock: data.stock ?? [] };
  } catch {
    return { ok: false, error: "No fue posible consultar inventario." };
  }
}

export default function InventoryManager({ branches }: { branches: Branch[] }) {
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [stock, setStock] = useState<Stock[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(branches.length > 0);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [productSearch, setProductSearch] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  const [lotNumber, setLotNumber] = useState("");
  const [expirationDate, setExpirationDate] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitCost, setUnitCost] = useState("");
  const [reason, setReason] = useState("");

  const [lots, setLots] = useState<Lot[]>([]);
  const [selectedLot, setSelectedLot] = useState("");
  const [adjustmentDirection, setAdjustmentDirection] = useState<"in" | "out">("out");
  const [adjustmentQuantity, setAdjustmentQuantity] = useState("1");
  const [adjustmentReason, setAdjustmentReason] = useState("");

  const applyStock = useCallback((result: StockResult) => {
    if (result.ok) {
      setStock(result.stock);
      setError("");
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, []);

  // Recarga manual (botones y después de registrar operaciones).
  const loadStock = useCallback(async () => {
    if (!branchId) return;
    setLoading(true);
    applyStock(await fetchStock(branchId, search));
  }, [branchId, search, applyStock]);

  // Carga por sucursal y búsqueda: se descarta una respuesta vieja si llegó otra búsqueda después.
  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    void fetchStock(branchId, search).then((result) => {
      if (!cancelled) applyStock(result);
    });
    return () => {
      cancelled = true;
    };
  }, [branchId, search, applyStock]);

  async function searchProducts(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    setSelectedProduct(null);
    setProducts([]);

    if (productSearch.trim().length < 2) {
      setError("Escribe al menos dos caracteres para buscar.");
      return;
    }

    try {
      const params = new URLSearchParams({ branchId, search: productSearch.trim() });
      const response = await fetch(`/api/inventory/products?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No fue posible buscar productos.");
      setProducts(data.products ?? []);
      if ((data.products ?? []).length === 0) setMessage("No encontramos productos con ese criterio.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error buscando productos.");
    }
  }

  async function chooseProduct(product: Product) {
    setSelectedProduct(product);
    setProducts([]);
    setProductSearch(product.product_name);
    setLots([]);
    setSelectedLot("");

    try {
      const params = new URLSearchParams({ branchId, productId: product.id });
      const response = await fetch(`/api/inventory/lots?${params}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No fue posible consultar los lotes.");
      setLots(data.lots ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error consultando lotes.");
    }
  }

  async function submitReceipt(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");

    if (!selectedProduct) {
      setError("Primero busca y selecciona un producto del catálogo.");
      return;
    }

    try {
      const response = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "receipt",
          branchId,
          productId: selectedProduct.id,
          lotNumber,
          expirationDate,
          quantity: Number(quantity),
          unitCost: unitCost === "" ? undefined : Number(unitCost),
          reason: reason || "Recepción de mercancía",
          idempotencyKey: crypto.randomUUID(),
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No fue posible registrar la recepción.");

      setMessage(data.message);
      setLotNumber("");
      setExpirationDate("");
      setQuantity("1");
      setUnitCost("");
      setReason("");
      await chooseProduct(selectedProduct);
      await loadStock();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error registrando recepción.");
    }
  }

  async function submitAdjustment(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");

    if (!selectedProduct || !selectedLot) {
      setError("Selecciona un producto y uno de sus lotes.");
      return;
    }

    try {
      const response = await fetch("/api/inventory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "adjustment",
          branchId,
          productId: selectedProduct.id,
          lotId: selectedLot,
          direction: adjustmentDirection,
          quantity: Number(adjustmentQuantity),
          reason: adjustmentReason,
          idempotencyKey: crypto.randomUUID(),
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No fue posible registrar el ajuste.");

      setMessage(data.message);
      setAdjustmentQuantity("1");
      setAdjustmentReason("");
      await chooseProduct(selectedProduct);
      await loadStock();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error registrando ajuste.");
    }
  }

  const totalProducts = stock.length;
  const outOfStock = stock.filter((item) => Number(item.quantity_available) <= 0).length;
  const lowStock = stock.filter((item) => ["reorder", "low_stock"].includes(item.stock_status)).length;

  return (
    <main className="mx-auto max-w-7xl space-y-6 p-6 md:p-10">
      <div>
        <p className="text-sm font-semibold text-green-700">OPERACIONES</p>
        <h2 className="mt-2 text-3xl font-bold">Inventario</h2>
        <p className="mt-2 text-gray-500">Existencias, recepción de mercancía y control de lotes.</p>
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <label className="mb-2 block text-sm font-semibold">Sucursal</label>
        <select
          value={branchId}
          onChange={(e) => {
            setLoading(true);
            setBranchId(e.target.value);
          }}
          className="w-full max-w-md rounded-lg border border-gray-300 px-3 py-3"
        >
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>{branch.name} ({branch.code})</option>
          ))}
        </select>
      </section>

      {message && <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">{message}</div>}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>}

      <section className="grid gap-4 sm:grid-cols-3">
        <article className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-sm text-gray-500">Productos con inventario</p>
          <p className="mt-2 text-3xl font-bold">{totalProducts}</p>
        </article>
        <article className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-sm text-gray-500">Existencias bajas</p>
          <p className="mt-2 text-3xl font-bold text-amber-600">{lowStock}</p>
        </article>
        <article className="rounded-xl border border-gray-200 bg-white p-5">
          <p className="text-sm text-gray-500">Agotados</p>
          <p className="mt-2 text-3xl font-bold text-red-600">{outOfStock}</p>
        </article>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold">Existencias actuales</h3>
            <p className="text-sm text-gray-500">Solo aparecen productos que ya tienen movimientos de inventario.</p>
          </div>
          <button onClick={() => void loadStock()} className="rounded-lg border px-4 py-2 text-sm font-medium hover:bg-gray-50">
            Actualizar
          </button>
        </div>

        <form onSubmit={(e) => { e.preventDefault(); void loadStock(); }} className="mb-4 flex flex-wrap gap-2">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar medicamento, marca, registro o código..." className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2" />
          <button className="rounded-lg bg-green-700 px-5 py-2 text-sm font-semibold text-white hover:bg-green-800">Buscar</button>
        </form>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[750px] text-left text-sm">
            <thead className="border-b bg-gray-50 text-gray-500">
              <tr>
                <th className="p-3">Producto</th>
                <th className="p-3">Presentación</th>
                <th className="p-3">Existencia</th>
                <th className="p-3">Reservado</th>
                <th className="p-3">Disponible</th>
                <th className="p-3">Estado</th>
              </tr>
            </thead>
            <tbody>
              {stock.map((item) => (
                <tr key={item.product_id} className="border-b last:border-0">
                  <td className="p-3">
                    <p className="font-semibold">{item.product_name}</p>
                    <p className="text-xs text-gray-500">{item.brand_name || "Sin marca registrada"}</p>
                  </td>
                  <td className="p-3">{[item.strength, item.dosage_form, item.presentation].filter(Boolean).join(" · ") || item.sale_unit}</td>
                  <td className="p-3 font-semibold">{Number(item.quantity_on_hand)}</td>
                  <td className="p-3">{Number(item.quantity_reserved)}</td>
                  <td className="p-3 font-semibold">{Number(item.quantity_available)}</td>
                  <td className="p-3">
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                      item.stock_status === "out_of_stock" ? "bg-red-100 text-red-700" :
                      item.stock_status === "reorder" || item.stock_status === "low_stock" ? "bg-amber-100 text-amber-700" :
                      "bg-green-100 text-green-700"
                    }`}>
                      {item.stock_status === "out_of_stock" ? "Agotado" :
                       item.stock_status === "reorder" ? "Reordenar" :
                       item.stock_status === "low_stock" ? "Stock bajo" : "Normal"}
                    </span>
                  </td>
                </tr>
              ))}
              {stock.length === 0 && (
                <tr><td colSpan={6} className="p-8 text-center text-gray-500">{loading ? "Cargando inventario..." : "Todavía no hay existencias registradas para esta sucursal."}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-lg font-bold">Recibir mercancía</h3>
          <p className="mb-4 mt-1 text-sm text-gray-500">Busca un producto del catálogo y registra su lote.</p>

          <form onSubmit={searchProducts} className="mb-4 flex gap-2">
            <input value={productSearch} onChange={(e) => setProductSearch(e.target.value)} placeholder="Nombre, marca, registro o código..." className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2" />
            <button className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white">Buscar</button>
          </form>

          {products.length > 0 && (
            <div className="mb-4 max-h-64 overflow-y-auto rounded-lg border">
              {products.map((product) => (
                <button type="button" key={product.id} onClick={() => void chooseProduct(product)} className="block w-full border-b p-3 text-left last:border-0 hover:bg-green-50">
                  <span className="block text-sm font-semibold">{product.product_name}</span>
                  <span className="block text-xs text-gray-500">{[product.brand_name, product.strength, product.dosage_form, product.presentation].filter(Boolean).join(" · ")}</span>
                  <span className="mt-1 block text-xs text-amber-700">Estado del catálogo: {product.verification_status}{product.is_active ? " · Activo" : " · Inactivo"}</span>
                </button>
              ))}
            </div>
          )}

          {selectedProduct && (
            <div className="mb-4 rounded-lg bg-green-50 p-3 text-sm">
              <p className="font-semibold text-green-900">{selectedProduct.product_name}</p>
              <p className="text-green-800">Seleccionado para recepción. Esto no habilita el producto para la venta.</p>
              {lots.length > 0 && <p className="mt-1 text-green-800">{lots.length} lote(s) registrado(s) anteriormente.</p>}
            </div>
          )}

          <form onSubmit={submitReceipt} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Número de lote</label>
              <input required value={lotNumber} onChange={(e) => setLotNumber(e.target.value)} className="w-full rounded-lg border px-3 py-2" />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium">Fecha de vencimiento</label>
                <input required type="date" value={expirationDate} onChange={(e) => setExpirationDate(e.target.value)} className="w-full rounded-lg border px-3 py-2" />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">Cantidad recibida</label>
                <input required min="1" step="1" type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} className="w-full rounded-lg border px-3 py-2" />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Costo unitario (opcional)</label>
              <input min="0" step="0.01" type="number" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} className="w-full rounded-lg border px-3 py-2" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Observación (opcional)</label>
              <input value={reason} onChange={(e) => setReason(e.target.value)} className="w-full rounded-lg border px-3 py-2" />
            </div>
            <button disabled={!selectedProduct} className="w-full rounded-lg bg-green-700 px-5 py-3 font-semibold text-white hover:bg-green-800 disabled:cursor-not-allowed disabled:opacity-40">
              Registrar recepción
            </button>
          </form>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <h3 className="text-lg font-bold">Ajustar inventario</h3>
          <p className="mb-4 mt-1 text-sm text-gray-500">Selecciona un producto y un lote para registrar una corrección.</p>

          {selectedProduct ? (
            <div className="mb-4 rounded-lg bg-gray-50 p-3 text-sm font-medium">{selectedProduct.product_name}</div>
          ) : (
            <div className="mb-4 rounded-lg border border-dashed p-4 text-sm text-gray-500">Primero selecciona un producto en el formulario de recepción.</div>
          )}

          <div className="mb-4">
            <label className="mb-1 block text-sm font-medium">Lote</label>
            <select value={selectedLot} onChange={(e) => setSelectedLot(e.target.value)} className="w-full rounded-lg border px-3 py-2">
              <option value="">Seleccionar lote</option>
              {lots.filter((lot) => lot.status === "available").map((lot) => (
                <option key={lot.id} value={lot.id}>
                  {lot.lot_number} · Disponible: {Number(lot.quantity_remaining)} · Vence: {lot.expiration_date ? new Date(lot.expiration_date).toLocaleDateString("es-DO") : "Sin fecha"}
                </option>
              ))}
            </select>
          </div>

          <form onSubmit={submitAdjustment} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium">Tipo de ajuste</label>
              <select value={adjustmentDirection} onChange={(e) => setAdjustmentDirection(e.target.value as "in" | "out")} className="w-full rounded-lg border px-3 py-2">
                <option value="out">Salida, descontar unidades</option>
                <option value="in">Entrada, agregar unidades</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Cantidad</label>
              <input required min="1" step="1" type="number" value={adjustmentQuantity} onChange={(e) => setAdjustmentQuantity(e.target.value)} className="w-full rounded-lg border px-3 py-2" />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium">Motivo obligatorio</label>
              <textarea required minLength={5} value={adjustmentReason} onChange={(e) => setAdjustmentReason(e.target.value)} className="w-full rounded-lg border px-3 py-2" rows={3} placeholder="Ej. Diferencia detectada durante conteo físico" />
            </div>
            <button disabled={!selectedProduct || !selectedLot} className="w-full rounded-lg bg-gray-900 px-5 py-3 font-semibold text-white hover:bg-black disabled:cursor-not-allowed disabled:opacity-40">
              Registrar ajuste
            </button>
          </form>
        </div>
      </section>
      <InventoryMovements key={`mov-${branchId}`} branchId={branchId} />

      <InventoryAlerts key={`alert-${branchId}`} branchId={branchId} />
    </main>
  );
}