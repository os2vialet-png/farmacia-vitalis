"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Branch = { id: string; code: string; name: string };
type Supplier = { id: string; name: string; commercial_name: string | null; tax_id: string | null };
type Product = {
  id: string;
  product_name: string;
  brand_name: string | null;
  presentation: string | null;
  sale_unit: string | null;
  verification_status: string;
  is_active: boolean;
};
type Order = {
  id: string;
  order_number: string;
  status: string;
  order_date: string;
  expected_date: string | null;
  supplier_name: string;
  product_lines: number;
  units_ordered: number;
  units_received: number;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
};
type CartItem = {
  product: Product;
  quantity: number;
  unitCost: number;
};

const money = (value: number | string) =>
  new Intl.NumberFormat("es-DO", {
    style: "currency",
    currency: "DOP",
    minimumFractionDigits: 2,
  }).format(Number(value || 0));

const statusLabels: Record<string, string> = {
  draft: "Borrador",
  ordered: "Ordenada",
  partially_received: "Recepción parcial",
  received: "Recibida",
  cancelled: "Cancelada",
};

type PurchasesResult =
  | { ok: true; data: { branches: Branch[]; suppliers: Supplier[]; orders: Order[] } }
  | { ok: false; error: string };

/** Consulta pura: no toca estado de React. */
async function fetchPurchases(selectedBranch?: string): Promise<PurchasesResult> {
  try {
    const query = selectedBranch ? `?branchId=${encodeURIComponent(selectedBranch)}` : "";
    const response = await fetch(`/api/purchases${query}`, { cache: "no-store" });
    const data = await response.json();

    if (!response.ok) {
      return { ok: false, error: data.error || "No fue posible cargar las compras." };
    }

    return {
      ok: true,
      data: { branches: data.branches || [], suppliers: data.suppliers || [], orders: data.orders || [] },
    };
  } catch {
    return { ok: false, error: "Error cargando compras." };
  }
}

export default function PurchasesManager() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [branchId, setBranchId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [expectedDate, setExpectedDate] = useState("");
  const [taxAmount, setTaxAmount] = useState("0");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [receivingOrderId, setReceivingOrderId] = useState("");
  const [receiveItems, setReceiveItems] = useState<Array<{
    purchaseOrderItemId: string;
    productName: string;
    quantityOrdered: number;
    quantityReceivedBefore: number;
    pendingQuantity: number;
    quantityReceived: number;
    lotNumber: string;
    expirationDate: string;
    unitCost: number;
  }>>([]);
  const [receiving, setReceiving] = useState(false);
  const [actionLoading, setActionLoading] = useState("");

  const subtotal = useMemo(
    () => cart.reduce((sum, item) => sum + item.quantity * item.unitCost, 0),
    [cart],
  );
  const tax = Math.max(0, Number(taxAmount) || 0);
  const total = subtotal + tax;

  const applyPurchases = useCallback((result: PurchasesResult, selectedBranch?: string) => {
    if (result.ok) {
      setBranches(result.data.branches);
      setSuppliers(result.data.suppliers);
      setOrders(result.data.orders);

      if (!selectedBranch && result.data.branches.length) {
        const first = result.data.branches[0].id;
        setBranchId((current: string) => current || first);
      }
      setErrorMessage("");
    } else {
      setErrorMessage(result.error);
    }
    setLoading(false);
  }, []);

  // Recarga después de aprobar, recibir o crear órdenes.
  const load = useCallback(async (selectedBranch?: string) => {
    applyPurchases(await fetchPurchases(selectedBranch), selectedBranch);
  }, [applyPurchases]);

  // Carga inicial (sucursales y suplidores): el estado solo cambia en el callback de la respuesta.
  useEffect(() => {
    let cancelled = false;
    void fetchPurchases().then((result) => {
      if (!cancelled) applyPurchases(result);
    });
    return () => {
      cancelled = true;
    };
  }, [applyPurchases]);

  // Órdenes de la sucursal seleccionada; se descarta la respuesta si la sucursal cambió antes.
  useEffect(() => {
    if (!branchId) return;
    let cancelled = false;
    void fetchPurchases(branchId).then((result) => {
      if (!cancelled) applyPurchases(result, branchId);
    });
    return () => {
      cancelled = true;
    };
  }, [branchId, applyPurchases]);

  useEffect(() => {
    const term = productSearch.trim();

    if (term.length < 2) {
      return;
    }

    let cancelled = false;

    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const response = await fetch(
          `/api/purchases?products=${encodeURIComponent(term)}`,
          { cache: "no-store" },
        );
        const data = await response.json();

        if (!response.ok) throw new Error(data.error || "Error buscando productos.");
        if (!cancelled) setProducts(data.products || []);
      } catch (e) {
        if (!cancelled) {
          setErrorMessage(e instanceof Error ? e.message : "Error buscando productos.");
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [productSearch]);

  // Resultados visibles derivados del texto: con menos de 2 caracteres no se muestra nada.
  const visibleProducts = productSearch.trim().length >= 2 ? products : [];

  function addProduct(product: Product) {
    setCart(current => {
      const existing = current.find(item => item.product.id === product.id);

      if (existing) {
        return current.map(item =>
          item.product.id === product.id
            ? { ...item, quantity: item.quantity + 1 }
            : item,
        );
      }

      return [...current, { product, quantity: 1, unitCost: 0 }];
    });

    setProductSearch("");
    setProducts([]);
    setErrorMessage("");
  }

  function updateItem(productId: string, field: "quantity" | "unitCost", value: number) {
    setCart(current =>
      current.map(item =>
        item.product.id === productId
          ? { ...item, [field]: value }
          : item,
      ),
    );
  }

  function removeItem(productId: string) {
    setCart(current => current.filter(item => item.product.id !== productId));
  }

  function resetOrder() {
    setCart([]);
    setSupplierId("");
    setExpectedDate("");
    setTaxAmount("0");
    setNotes("");
    setShowForm(false);
  }

  async function saveOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setErrorMessage("");

    if (!branchId) {
      setErrorMessage("Selecciona una sucursal.");
      return;
    }

    if (!supplierId) {
      setErrorMessage("Selecciona un suplidor.");
      return;
    }

    if (!cart.length) {
      setErrorMessage("Agrega al menos un producto a la orden.");
      return;
    }

    if (cart.some(item => !Number.isInteger(item.quantity) || item.quantity <= 0)) {
      setErrorMessage("Todas las cantidades deben ser números enteros mayores que cero.");
      return;
    }

    if (cart.some(item => !Number.isFinite(item.unitCost) || item.unitCost < 0)) {
      setErrorMessage("Revisa los costos unitarios.");
      return;
    }

    setSaving(true);

    try {
      const response = await fetch("/api/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId,
          supplierId,
          expectedDate: expectedDate || null,
          taxAmount: tax,
          notes,
          items: cart.map(item => ({
            productId: item.product.id,
            quantity: item.quantity,
            unitCost: item.unitCost,
          })),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "No fue posible guardar la orden.");
      }

      setMessage(`Orden ${data.order.order_number} creada correctamente.`);
      resetOrder();
      await load(branchId);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Error creando la orden.");
    } finally {
      setSaving(false);
    }
  }

  async function approveOrder(orderId: string) {
    if (!window.confirm("¿Confirmas la aprobación de esta orden de compra?")) return;

    setActionLoading(orderId);
    setMessage("");
    setErrorMessage("");

    try {
      const response = await fetch(`/api/purchases/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "order" })
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "No se pudo aprobar la orden.");

      setMessage(data.message);
      await load(branchId);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Error aprobando la orden.");
    } finally {
      setActionLoading("");
    }
  }

  async function openReceiving(orderId: string) {
    setActionLoading(orderId);
    setErrorMessage("");
    setMessage("");

    try {
      const response = await fetch(`/api/purchases/${orderId}`, {
        cache: "no-store"
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "No se pudo consultar la orden.");

      if (!["ordered", "partially_received"].includes(data.order.status)) {
        throw new Error("Esta orden no está disponible para recepción.");
      }

      const items = (data.items || []).map((item: {
        id: string;
        product_name: string;
        quantity_ordered: number | string;
        quantity_received: number | string;
        unit_cost: number | string;
      }) => {
        const ordered = Number(item.quantity_ordered);
        const received = Number(item.quantity_received);
        const pending = ordered - received;

        return {
          purchaseOrderItemId: item.id,
          productName: item.product_name,
          quantityOrdered: ordered,
          quantityReceivedBefore: received,
          pendingQuantity: pending,
          quantityReceived: pending,
          lotNumber: "",
          expirationDate: "",
          unitCost: Number(item.unit_cost)
        };
      });

      setReceivingOrderId(orderId);
      setReceiveItems(items);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Error consultando la orden.");
    } finally {
      setActionLoading("");
    }
  }

  function updateReceiveItem(
    itemId: string,
    field: "quantityReceived" | "lotNumber" | "expirationDate" | "unitCost",
    value: string | number
  ) {
    setReceiveItems(current =>
      current.map(item =>
        item.purchaseOrderItemId === itemId
          ? { ...item, [field]: value }
          : item
      )
    );
  }

  async function submitReceipt() {
    setErrorMessage("");
    setMessage("");

    const selectedItems = receiveItems.filter(item => item.quantityReceived > 0);

    if (!selectedItems.length) {
      setErrorMessage("Indica al menos una cantidad para recibir.");
      return;
    }

    for (const item of selectedItems) {
      if (!Number.isInteger(item.quantityReceived) ||
          item.quantityReceived > item.pendingQuantity) {
        setErrorMessage(`Cantidad inválida para ${item.productName}. Pendiente: ${item.pendingQuantity}.`);
        return;
      }

      if (!item.lotNumber.trim()) {
        setErrorMessage(`Debes indicar el lote de ${item.productName}.`);
        return;
      }

      if (!item.expirationDate) {
        setErrorMessage(`Debes indicar el vencimiento de ${item.productName}.`);
        return;
      }

      if (!Number.isFinite(item.unitCost) || item.unitCost < 0) {
        setErrorMessage(`El costo de ${item.productName} no es válido.`);
        return;
      }
    }

    setReceiving(true);

    try {
      const response = await fetch(`/api/purchases/${receivingOrderId}/receipts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: "",
          items: selectedItems.map(item => ({
            purchaseOrderItemId: item.purchaseOrderItemId,
            quantityReceived: item.quantityReceived,
            lotNumber: item.lotNumber.trim(),
            expirationDate: item.expirationDate,
            unitCost: item.unitCost
          }))
        })
      });

      const data = await response.json();

      if (!response.ok) throw new Error(data.error || "No se pudo registrar la recepción.");

      setMessage(
        `Recepción ${data.receipt.receiptNumber} registrada correctamente. Inventario actualizado.`
      );
      setReceivingOrderId("");
      setReceiveItems([]);
      await load(branchId);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : "Error registrando recepción.");
    } finally {
      setReceiving(false);
    }
  }
  const inputClass =
    "w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-blue-600";
  const labelClass = "mb-1 block text-sm font-medium text-gray-700";

  return (
    <main className="space-y-6 p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Compras</h1>
          <p className="mt-1 text-sm text-gray-500">
            Órdenes de compra y abastecimiento de inventario.
          </p>
        </div>

        <button
          onClick={() => {
            resetOrder();
            setShowForm(true);
            setMessage("");
            setErrorMessage("");
          }}
          className="rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + Nueva orden
        </button>
      </div>

      {message && (
        <div role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          {message}
        </div>
      )}

      {errorMessage && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {errorMessage}
        </div>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <label className="w-full max-w-md">
            <span className={labelClass}>Sucursal</span>
            <select
              className={inputClass}
              value={branchId}
              onChange={e => { if (e.target.value) setLoading(true); setBranchId(e.target.value); }}
            >
              <option value="">Seleccionar sucursal</option>
              {branches.map(branch => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </label>
          <div className="text-sm text-gray-500">
            {orders.length} órdenes registradas
          </div>
        </div>

        {loading ? (
          <p className="p-8 text-center text-gray-500">Cargando órdenes...</p>
        ) : orders.length === 0 ? (
          <p className="p-8 text-center text-gray-500">
            No hay órdenes de compra en esta sucursal.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[750px] text-left text-sm">
              <thead className="border-b bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-3 py-3">Orden</th>
                  <th className="px-3 py-3">Suplidor</th>
                  <th className="px-3 py-3">Fecha</th>
                  <th className="px-3 py-3">Productos</th>
                  <th className="px-3 py-3">Recepción</th>
                  <th className="px-3 py-3">Total</th>
                  <th className="px-3 py-3">Estado</th>
                  <th className="px-3 py-3">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {orders.map(order => (
                  <tr key={order.id} className="hover:bg-gray-50">
                    <td className="px-3 py-4 font-semibold text-gray-900">
                      {order.order_number}
                    </td>
                    <td className="px-3 py-4">{order.supplier_name}</td>
                    <td className="px-3 py-4">
                      {new Date(order.order_date).toLocaleDateString("es-DO")}
                    </td>
                    <td className="px-3 py-4">{order.product_lines} líneas</td>
                    <td className="px-3 py-4">
                      {order.units_received} / {order.units_ordered}
                    </td>
                    <td className="px-3 py-4 font-medium">{money(order.total_amount)}</td>
                    <td className="px-3 py-4">
                      <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-gray-700">
                        {statusLabels[order.status] || order.status}
                      </span>
                    </td>
                    <td className="px-3 py-4">
                      <div className="flex flex-wrap gap-2">
                        {order.status === "draft" && (
                          <button
                            type="button"
                            disabled={actionLoading === order.id}
                            onClick={() => approveOrder(order.id)}
                            className="rounded-md bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-800 disabled:opacity-50"
                          >
                            {actionLoading === order.id ? "Procesando..." : "Aprobar"}
                          </button>
                        )}
                        {["ordered", "partially_received"].includes(order.status) && (
                          <button
                            type="button"
                            disabled={actionLoading === order.id}
                            onClick={() => openReceiving(order.id)}
                            className="rounded-md bg-green-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-800 disabled:opacity-50"
                          >
                            {actionLoading === order.id ? "Cargando..." : "Recibir"}
                          </button>
                        )}
                        {order.status === "received" && (
                          <span className="text-xs text-green-700">Completada</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {receivingOrderId && (
        <section className="space-y-5 rounded-xl border border-green-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Recepción de mercancía</h2>
              <p className="text-sm text-gray-500">
                Registra las cantidades, lotes y vencimientos de los productos recibidos.
              </p>
            </div>
            <button
              type="button"
              disabled={receiving}
              onClick={() => {
                setReceivingOrderId("");
                setReceiveItems([]);
              }}
              className="text-sm text-gray-500 hover:text-gray-900"
            >
              Cerrar
            </button>
          </div>

          <div className="space-y-4">
            {receiveItems.map(item => (
              <div
                key={item.purchaseOrderItemId}
                className="space-y-3 rounded-lg border border-gray-200 p-4"
              >
                <div>
                  <h3 className="font-semibold text-gray-900">{item.productName}</h3>
                  <p className="text-xs text-gray-500">
                    Ordenado: {item.quantityOrdered} · Recibido anteriormente: {item.quantityReceivedBefore} · Pendiente: {item.pendingQuantity}
                  </p>
                </div>

                {item.pendingQuantity > 0 ? (
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <label>
                      <span className={labelClass}>Cantidad recibida</span>
                      <input
                        type="number"
                        min="0"
                        max={item.pendingQuantity}
                        step="1"
                        className={inputClass}
                        value={item.quantityReceived}
                        onChange={e => updateReceiveItem(
                          item.purchaseOrderItemId,
                          "quantityReceived",
                          Number(e.target.value)
                        )}
                      />
                    </label>

                    <label>
                      <span className={labelClass}>Número de lote</span>
                      <input
                        type="text"
                        maxLength={100}
                        className={inputClass}
                        value={item.lotNumber}
                        onChange={e => updateReceiveItem(
                          item.purchaseOrderItemId,
                          "lotNumber",
                          e.target.value
                        )}
                        placeholder="Ej. LOT-2026-001"
                      />
                    </label>

                    <label>
                      <span className={labelClass}>Fecha de vencimiento</span>
                      <input
                        type="date"
                        min={new Date().toISOString().slice(0, 10)}
                        className={inputClass}
                        value={item.expirationDate}
                        onChange={e => updateReceiveItem(
                          item.purchaseOrderItemId,
                          "expirationDate",
                          e.target.value
                        )}
                      />
                    </label>

                    <label>
                      <span className={labelClass}>Costo unitario (RD$)</span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className={inputClass}
                        value={item.unitCost}
                        onChange={e => updateReceiveItem(
                          item.purchaseOrderItemId,
                          "unitCost",
                          Number(e.target.value)
                        )}
                      />
                    </label>
                  </div>
                ) : (
                  <p className="text-sm text-green-700">Producto recibido completamente.</p>
                )}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={receiving}
              onClick={submitReceipt}
              className="rounded-lg bg-green-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-green-800 disabled:opacity-50"
            >
              {receiving ? "Registrando recepción..." : "Confirmar recepción"}
            </button>
            <button
              type="button"
              disabled={receiving}
              onClick={() => {
                setReceivingOrderId("");
                setReceiveItems([]);
              }}
              className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm"
            >
              Cancelar
            </button>
          </div>
        </section>
      )}
      {showForm && (
        <form onSubmit={saveOrder} className="space-y-5 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Nueva orden de compra</h2>
              <p className="text-sm text-gray-500">Los productos se agregarán al inventario cuando sean recibidos.</p>
            </div>
            <button type="button" onClick={resetOrder} className="text-sm text-gray-500 hover:text-gray-900">
              Cerrar
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <label>
              <span className={labelClass}>Sucursal *</span>
              <select required className={inputClass} value={branchId} onChange={e => { if (e.target.value) setLoading(true); setBranchId(e.target.value); }}>
                <option value="">Seleccionar</option>
                {branches.map(branch => (
                  <option key={branch.id} value={branch.id}>{branch.name}</option>
                ))}
              </select>
            </label>

            <label>
              <span className={labelClass}>Suplidor *</span>
              <select required className={inputClass} value={supplierId} onChange={e => setSupplierId(e.target.value)}>
                <option value="">Seleccionar suplidor</option>
                {suppliers.map(supplier => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}{supplier.tax_id ? ` · ${supplier.tax_id}` : ""}
                  </option>
                ))}
              </select>
              {suppliers.length === 0 && (
                <span className="mt-1 block text-xs text-amber-700">
                  No hay suplidores activos. Registra uno en Suplidores.
                </span>
              )}
            </label>

            <label>
              <span className={labelClass}>Fecha estimada de entrega</span>
              <input type="date" className={inputClass} value={expectedDate} onChange={e => setExpectedDate(e.target.value)} />
            </label>
          </div>

          <div>
            <label>
              <span className={labelClass}>Buscar productos del catálogo</span>
              <input
                className={inputClass}
                value={productSearch}
                onChange={e => setProductSearch(e.target.value)}
                placeholder="Escribe el nombre, marca, registro sanitario o código..."
              />
            </label>

            {(searching || visibleProducts.length > 0) && (
              <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-gray-200">
                {searching && <p className="p-3 text-sm text-gray-500">Buscando...</p>}
                {visibleProducts.map(product => (
                  <button
                    type="button"
                    key={product.id}
                    onClick={() => addProduct(product)}
                    className="flex w-full items-center justify-between gap-3 border-b border-gray-100 px-3 py-3 text-left last:border-0 hover:bg-blue-50"
                  >
                    <span>
                      <span className="block text-sm font-medium text-gray-900">{product.product_name}</span>
                      <span className="block text-xs text-gray-500">
                        {[product.brand_name, product.presentation, product.sale_unit].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="shrink-0 text-sm font-semibold text-blue-700">Agregar +</span>
                  </button>
                ))}
                {!searching && visibleProducts.length === 0 && productSearch.trim().length >= 2 && (
                  <p className="p-3 text-sm text-gray-500">No se encontraron productos.</p>
                )}
              </div>
            )}
          </div>

          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full min-w-[700px] text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-3 py-3">Producto</th>
                  <th className="px-3 py-3">Cantidad</th>
                  <th className="px-3 py-3">Costo unitario (RD$)</th>
                  <th className="px-3 py-3">Importe</th>
                  <th className="px-3 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {cart.length === 0 ? (
                  <tr><td colSpan={5} className="p-8 text-center text-gray-500">Busca y agrega productos para comenzar.</td></tr>
                ) : cart.map(item => (
                  <tr key={item.product.id}>
                    <td className="px-3 py-3">
                      <div className="font-medium text-gray-900">{item.product.product_name}</div>
                      <div className="text-xs text-gray-500">
                        {[item.product.brand_name, item.product.presentation].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <input
                        type="number"
                        min="1"
                        step="1"
                        className="w-24 rounded border border-gray-300 px-2 py-1.5"
                        value={item.quantity}
                        onChange={e => updateItem(item.product.id, "quantity", Number(e.target.value))}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className="w-32 rounded border border-gray-300 px-2 py-1.5"
                        value={item.unitCost}
                        onChange={e => updateItem(item.product.id, "unitCost", Number(e.target.value))}
                      />
                    </td>
                    <td className="px-3 py-3 font-semibold">{money(item.quantity * item.unitCost)}</td>
                    <td className="px-3 py-3 text-right">
                      <button type="button" onClick={() => removeItem(item.product.id)} className="text-red-600 hover:underline">
                        Quitar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label>
              <span className={labelClass}>Notas de la orden</span>
              <textarea rows={3} maxLength={3000} className={inputClass} value={notes} onChange={e => setNotes(e.target.value)} />
            </label>

            <div className="space-y-3 rounded-lg bg-gray-50 p-4">
              <div className="flex justify-between text-sm">
                <span className="text-gray-600">Subtotal</span>
                <strong>{money(subtotal)}</strong>
              </div>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span className="text-gray-600">Impuestos (RD$)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="w-36 rounded border border-gray-300 px-2 py-1.5 text-right"
                  value={taxAmount}
                  onChange={e => setTaxAmount(e.target.value)}
                />
              </label>
              <div className="flex justify-between border-t border-gray-200 pt-3 text-base">
                <span className="font-semibold text-gray-900">Total</span>
                <strong className="text-blue-800">{money(total)}</strong>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={saving || !cart.length || !branchId || !supplierId}
              className="rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? "Guardando orden..." : "Guardar orden de compra"}
            </button>
            <button type="button" onClick={resetOrder} className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm">
              Cancelar
            </button>
          </div>
        </form>
      )}
    </main>
  );
}