"use client";

import Link from "next/link";
import ProductImage from "@/src/components/ProductImage";
import { usageLabel } from "@/src/lib/product-image";
import { useEffect, useMemo, useRef, useState } from "react";

type Branch = { id: string; name: string };

type Product = {
  id: string;
  productName: string;
  brandName: string | null;
  manufacturerName?: string | null;
  imageUrl?: string | null;
  dosageForm?: string | null;
  presentation: string | null;
  saleUnit: string;
  taxRate: number;
  unitPrice: string;
  available: number;
};

type Customer = { id: string; fullName: string; phone: string | null; documentNumber: string | null };

type CartLine = {
  product: Product;
  quantity: number;
  discount: number;
  discountReason: string;
};

type PaymentRow = { method: "cash" | "card" | "bank_transfer" | "other"; amount: string; reference: string };

const PAYMENT_LABELS: Record<PaymentRow["method"], string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  bank_transfer: "Transferencia",
  other: "Otro",
};

const money = (value: number) =>
  new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP", minimumFractionDigits: 2 }).format(
    Number.isFinite(value) ? value : 0,
  );

/** Identificador único para la operación. No depende de crypto.randomUUID (no disponible en HTTP sin certificado). */
function newOperationKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Cálculo de vista previa. El servidor recalcula todo y es la fuente de verdad. */
function previewLine(line: CartLine) {
  const gross = Number(line.product.unitPrice) * line.quantity;
  const net = Math.max(0, gross - line.discount);
  const rate = line.product.taxRate;
  const base = rate === 0 ? net : net / (1 + rate);
  return { net, tax: net - base };
}

export default function PosTerminal({
  branches,
  canDiscount,
  discountBranchIds,
}: {
  branches: Branch[];
  canDiscount: boolean;
  discountBranchIds: string[];
}) {
  const [branchId, setBranchId] = useState(branches[0]?.id ?? "");
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Product[]>([]);
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [customerTerm, setCustomerTerm] = useState("");
  const [customerResults, setCustomerResults] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([{ method: "cash", amount: "", reference: "" }]);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ saleId: string; saleNumber: string; change: string } | null>(null);
  const operationKey = useRef(newOperationKey());

  const canDiscountHere = canDiscount && discountBranchIds.includes(branchId);

  // Los resultados visibles se derivan del texto: con menos de 2 caracteres no se muestra nada.
  const visibleResults = branchId && term.trim().length >= 2 ? results : [];
  const visibleCustomers = customerTerm.trim().length >= 2 ? customerResults : [];

  useEffect(() => {
    const trimmed = term.trim();
    if (!branchId || trimmed.length < 2) {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const response = await fetch(
          `/api/pos/products?branchId=${encodeURIComponent(branchId)}&q=${encodeURIComponent(trimmed)}`,
          { cache: "no-store" },
        );
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "No fue posible buscar productos.");
        if (!cancelled) setResults(data.products || []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Error buscando productos.");
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, branchId]);

  useEffect(() => {
    const trimmed = customerTerm.trim();
    if (trimmed.length < 2) {
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/customers?q=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "No fue posible buscar clientes.");
        if (!cancelled) setCustomerResults(data.customers || []);
      } catch {
        if (!cancelled) setCustomerResults([]);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [customerTerm]);

  const totals = useMemo(() => {
    let total = 0;
    let tax = 0;
    for (const line of cart) {
      const preview = previewLine(line);
      total += preview.net;
      tax += preview.tax;
    }
    const paid = payments.reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
    const cash = payments
      .filter((payment) => payment.method === "cash")
      .reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
    const change = Math.max(0, paid - total);
    return { total, tax, paid, cash, change };
  }, [cart, payments]);

  function addProduct(product: Product) {
    setError("");
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      if (existing) {
        if (existing.quantity + 1 > product.available) {
          setError(`Solo hay ${product.available} ${product.saleUnit} disponibles de ${product.productName}.`);
          return current;
        }
        return current.map((line) =>
          line.product.id === product.id ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      if (product.available < 1) {
        setError(`${product.productName} no tiene existencias.`);
        return current;
      }
      return [...current, { product, quantity: 1, discount: 0, discountReason: "" }];
    });
    setTerm("");
    setResults([]);
  }

  function updateLine(productId: string, patch: Partial<CartLine>) {
    setCart((current) =>
      current.map((line) => (line.product.id === productId ? { ...line, ...patch } : line)),
    );
  }

  function resetSale() {
    setCart([]);
    setCustomer(null);
    setCustomerTerm("");
    setCustomerResults([]);
    setPayments([{ method: "cash", amount: "", reference: "" }]);
    setNotes("");
    setError("");
    operationKey.current = newOperationKey();
  }

  function changeBranch(next: string) {
    if (cart.length > 0 && !window.confirm("Cambiar de sucursal vaciará la venta actual. ¿Continuar?")) return;
    setBranchId(next);
    setCart([]);
    setResults([]);
    setTerm("");
    setDone(null);
    setError("");
    operationKey.current = newOperationKey();
  }

  function fillExactCash() {
    setPayments([{ method: "cash", amount: totals.total.toFixed(2), reference: "" }]);
  }

  async function confirmSale() {
    setError("");

    if (!branchId) return setError("Selecciona una sucursal.");
    if (cart.length === 0) return setError("Agrega al menos un producto.");

    for (const line of cart) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1) {
        return setError(`La cantidad de ${line.product.productName} no es válida.`);
      }
      if (line.quantity > line.product.available) {
        return setError(`Solo hay ${line.product.available} ${line.product.saleUnit} de ${line.product.productName}.`);
      }
      if (line.discount > 0 && !canDiscountHere) {
        return setError("No tienes permiso para aplicar descuentos en esta sucursal.");
      }
      if (line.discount > 0 && line.discountReason.trim().length < 3) {
        return setError(`Indica el motivo del descuento de ${line.product.productName}.`);
      }
    }

    const parsedPayments = payments.map((payment) => ({
      method: payment.method,
      amount: Number(payment.amount),
      reference: payment.reference.trim() || undefined,
    }));

    if (parsedPayments.some((payment) => !Number.isFinite(payment.amount) || payment.amount <= 0)) {
      return setError("Cada pago debe tener un importe mayor que cero.");
    }

    if (totals.paid < totals.total) {
      return setError(`El pago (${money(totals.paid)}) no cubre el total (${money(totals.total)}).`);
    }

    setSubmitting(true);

    try {
      const response = await fetch("/api/sales", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId,
          customerId: customer?.id ?? null,
          idempotencyKey: operationKey.current,
          notes: notes.trim() || undefined,
          items: cart.map((line) => ({
            productId: line.product.id,
            quantity: line.quantity,
            discount: line.discount,
            discountReason: line.discountReason.trim() || undefined,
          })),
          payments: parsedPayments,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || "No fue posible confirmar la venta.");
        return;
      }

      setDone({
        saleId: data.sale.id,
        saleNumber: data.sale.sale_number,
        change: data.sale.change_amount,
      });
      resetSale();
    } catch {
      setError("Se perdió la conexión. Revisa el historial antes de volver a cobrar: la venta pudo registrarse.");
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm text-gray-900 outline-none focus:border-[#00A651]";

  if (branches.length === 0) {
    return (
      <main className="p-6 md:p-10">
        <p className="rounded-xl border border-dashed border-gray-300 bg-white p-8 text-center text-gray-500">
          Tu cuenta no tiene sucursales asignadas para vender.
        </p>
      </main>
    );
  }

  return (
    <main className="space-y-6 p-4 md:p-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Punto de venta</h1>
          <p className="mt-1 text-sm text-gray-500">
            Solo se venden productos activos, verificados, con precio vigente y existencias disponibles.
          </p>
        </div>
        <label className="w-full max-w-xs">
          <span className="mb-1 block text-sm font-medium text-gray-700">Sucursal</span>
          <select className={inputClass} value={branchId} onChange={(event) => changeBranch(event.target.value)}>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {done && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          <span>
            Venta {done.saleNumber} registrada. Cambio: {money(Number(done.change))}.
          </span>
          <Link href={`/ventas/${done.saleId}`} className="font-semibold underline">
            Ver comprobante
          </Link>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <section className="space-y-4 xl:col-span-2">
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <label>
              <span className="mb-1 block text-sm font-medium text-gray-700">Buscar producto</span>
              <input
                className={inputClass}
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                placeholder="Nombre, marca, registro sanitario o código de barras"
                autoComplete="off"
              />
            </label>

            {(searching || visibleResults.length > 0 || (term.trim().length >= 2 && !searching)) && (
              <div className="mt-3 max-h-80 divide-y overflow-y-auto rounded-lg border border-gray-200">
                {searching && <p className="p-3 text-sm text-gray-500">Buscando...</p>}
                {!searching && visibleResults.length === 0 && term.trim().length >= 2 && (
                  <p className="p-3 text-sm text-gray-500">No hay productos vendibles con ese criterio.</p>
                )}
                {visibleResults.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    onClick={() => addProduct(product)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-green-50"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <ProductImage name={product.productName} dosageForm={product.dosageForm} imageUrl={product.imageUrl} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-gray-900">{product.productName}</span>
                        <span className="block text-xs font-semibold text-green-800">
                          {product.brandName ? `Marca: ${product.brandName}` : "Marca no registrada"}
                        </span>
                        <span className="block text-xs text-gray-500">
                          {[usageLabel(product.dosageForm), product.presentation, `Unidad: ${product.saleUnit}`].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-sm font-semibold text-gray-900">{money(Number(product.unitPrice))}</span>
                      <span className="block text-xs text-gray-500">Disponible: {product.available}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-3 py-3">Producto</th>
                  <th className="px-3 py-3">Cantidad</th>
                  <th className="px-3 py-3">Precio</th>
                  <th className="px-3 py-3">Descuento</th>
                  <th className="px-3 py-3">Importe</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {cart.length === 0 && (
                  <tr>
                    <td colSpan={6} className="p-8 text-center text-gray-500">
                      Busca y agrega productos para empezar la venta.
                    </td>
                  </tr>
                )}
                {cart.map((line) => {
                  const preview = previewLine(line);
                  return (
                    <tr key={line.product.id} className="align-top">
                      <td className="px-3 py-3">
                        <div className="font-medium text-gray-900">{line.product.productName}</div>
                        <div className="text-xs text-gray-500">
                          {line.product.taxRate > 0
                            ? `ITBIS incluido (${Math.round(line.product.taxRate * 100)}%)`
                            : "Sin impuesto configurado"}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <input
                          type="number"
                          min={1}
                          max={line.product.available}
                          step={1}
                          value={line.quantity}
                          onChange={(event) =>
                            updateLine(line.product.id, { quantity: Math.floor(Number(event.target.value)) || 0 })
                          }
                          className="w-24 rounded border border-gray-300 px-2 py-1.5"
                        />
                        <div className="mt-1 text-xs text-gray-400">{line.product.saleUnit}</div>
                      </td>
                      <td className="px-3 py-3">{money(Number(line.product.unitPrice))}</td>
                      <td className="px-3 py-3">
                        {canDiscountHere ? (
                          <div className="space-y-1">
                            <input
                              type="number"
                              min={0}
                              step="0.01"
                              value={line.discount}
                              onChange={(event) => updateLine(line.product.id, { discount: Number(event.target.value) || 0 })}
                              className="w-28 rounded border border-gray-300 px-2 py-1.5"
                              aria-label="Descuento en RD$"
                            />
                            <input
                              type="text"
                              maxLength={200}
                              placeholder="Motivo"
                              value={line.discountReason}
                              onChange={(event) => updateLine(line.product.id, { discountReason: event.target.value })}
                              className="w-40 rounded border border-gray-300 px-2 py-1.5 text-xs"
                            />
                          </div>
                        ) : (
                          <span className="text-xs text-gray-400">Sin permiso</span>
                        )}
                      </td>
                      <td className="px-3 py-3 font-semibold">{money(preview.net)}</td>
                      <td className="px-3 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setCart((current) => current.filter((item) => item.product.id !== line.product.id))}
                          className="text-red-600 hover:underline"
                        >
                          Quitar
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <h2 className="mb-2 text-sm font-semibold text-gray-900">Cliente (opcional)</h2>
            {customer ? (
              <div className="flex items-center justify-between gap-2 text-sm">
                <span>
                  {customer.fullName}
                  {customer.phone ? ` · ${customer.phone}` : ""}
                </span>
                <button type="button" onClick={() => setCustomer(null)} className="text-red-600 hover:underline">
                  Quitar
                </button>
              </div>
            ) : (
              <>
                <input
                  className={inputClass}
                  value={customerTerm}
                  onChange={(event) => setCustomerTerm(event.target.value)}
                  placeholder="Buscar por nombre o teléfono"
                />
                {visibleCustomers.length > 0 && (
                  <div className="mt-2 divide-y rounded-lg border border-gray-200">
                    {visibleCustomers.slice(0, 6).map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                          setCustomer(item);
                          setCustomerTerm("");
                          setCustomerResults([]);
                        }}
                        className="block w-full px-3 py-2 text-left text-sm hover:bg-green-50"
                      >
                        {item.fullName}
                        {item.phone ? <span className="text-gray-500"> · {item.phone}</span> : null}
                      </button>
                    ))}
                  </div>
                )}
                <Link href="/clientes" className="mt-2 block text-xs text-green-700 hover:underline">
                  Registrar cliente nuevo
                </Link>
              </>
            )}
          </div>

          <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Impuesto incluido</span>
              <span>{money(totals.tax)}</span>
            </div>
            <div className="flex justify-between text-lg font-bold">
              <span>Total</span>
              <span className="text-green-800">{money(totals.total)}</span>
            </div>

            <div className="space-y-2 border-t pt-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Pagos</span>
                <button type="button" onClick={fillExactCash} className="text-xs text-green-700 hover:underline">
                  Pago exacto en efectivo
                </button>
              </div>
              {payments.map((payment, index) => (
                <div key={index} className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <select
                    className="rounded border border-gray-300 px-2 py-2 text-sm"
                    value={payment.method}
                    onChange={(event) =>
                      setPayments((current) =>
                        current.map((item, i) =>
                          i === index ? { ...item, method: event.target.value as PaymentRow["method"] } : item,
                        ),
                      )
                    }
                  >
                    {Object.entries(PAYMENT_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={payment.amount}
                    onChange={(event) =>
                      setPayments((current) =>
                        current.map((item, i) => (i === index ? { ...item, amount: event.target.value } : item)),
                      )
                    }
                    className="rounded border border-gray-300 px-2 py-2 text-sm"
                    aria-label="Importe del pago"
                  />
                  <button
                    type="button"
                    disabled={payments.length === 1}
                    onClick={() => setPayments((current) => current.filter((_, i) => i !== index))}
                    className="text-xs text-red-600 disabled:opacity-30"
                  >
                    Quitar
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={payments.length >= 10}
                onClick={() => setPayments((current) => [...current, { method: "card", amount: "", reference: "" }])}
                className="text-xs text-green-700 hover:underline disabled:opacity-40"
              >
                + Agregar método de pago
              </button>
            </div>

            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Cambio</span>
              <span className={totals.change > totals.cash ? "font-semibold text-red-700" : ""}>
                {money(totals.change)}
              </span>
            </div>
            {totals.change > totals.cash && totals.paid >= totals.total && (
              <p className="text-xs text-red-700">El cambio solo se puede entregar en efectivo. Ajusta los pagos.</p>
            )}

            <textarea
              rows={2}
              maxLength={500}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Notas de la venta (opcional)"
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
            />

            <button
              type="button"
              onClick={confirmSale}
              disabled={submitting || cart.length === 0 || totals.paid < totals.total}
              className="w-full rounded-lg bg-[#00A651] px-4 py-3 font-semibold text-white hover:bg-[#008f45] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? "Registrando venta..." : "Confirmar venta"}
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm("¿Vaciar la venta actual?")) resetSale();
              }}
              disabled={submitting}
              className="w-full rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Vaciar venta
            </button>
          </div>
        </aside>
      </div>
    </main>
  );
}
