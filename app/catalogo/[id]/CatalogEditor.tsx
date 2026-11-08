"use client";

import { FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ProductImage from "@/src/components/ProductImage";

type Product = {
  id: string;
  name: string;
  dosageForm: string | null;
  imageUrl: string | null;
  brandName: string | null;
  strength: string | null;
  presentation: string | null;
  saleUnit: string | null;
  taxPercent: number | null;
  isActive: boolean;
  isPrescription: boolean;
  isControlled: boolean;
  verificationStatus: string;
  isDuplicate: boolean;
};

type Branch = { id: string; name: string; currentPrice: string | null };

const inputClass = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[var(--vitalis-green)] disabled:bg-gray-50";

export default function CatalogEditor({
  product,
  branches,
  permissions,
}: {
  product: Product;
  branches: Branch[];
  permissions: { update: boolean; verify: boolean; prices: boolean };
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [data, setData] = useState({
    brandName: product.brandName ?? "",
    strength: product.strength ?? "",
    presentation: product.presentation ?? "",
    saleUnit: product.saleUnit ?? "",
    taxPercent: product.taxPercent === null ? "" : String(product.taxPercent),
    isActive: product.isActive,
    isPrescription: product.isPrescription,
    isControlled: product.isControlled,
  });

  const [verify, setVerify] = useState({
    status: "verified" as "verified" | "needs_review" | "pending",
    evidenceType: "sanitary_registry" as "sanitary_registry" | "manual_review",
    evidenceReference: "",
    notes: "",
  });

  const [priceBranch, setPriceBranch] = useState(branches[0]?.id ?? "");
  const [priceValue, setPriceValue] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imageUrlDraft, setImageUrlDraft] = useState("");

  async function uploadImage(file: File) {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      if (file.size > 3 * 1024 * 1024) {
        setError("La imagen debe pesar menos de 3 MB.");
        return;
      }
      const form = new FormData();
      form.append("image", file);
      const response = await fetch(`/api/catalog/${product.id}/image`, { method: "POST", body: form });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || "No fue posible cargar la foto.");
        return;
      }
      setMessage("Foto del producto guardada.");
      router.refresh();
    } catch {
      setError("No se pudo conectar con el servidor.");
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  function submitImageUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    call(`/api/catalog/${product.id}/image`, "PUT", { imageUrl: imageUrlDraft.trim() }, "Foto guardada.");
    setImageUrlDraft("");
  }

  function removeImage() {
    call(`/api/catalog/${product.id}/image`, "DELETE", null, "Foto quitada.");
  }

  async function call(url: string, method: string, body: unknown, success: string) {
    setError("");
    setMessage("");
    setBusy(true);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error || "La operación no se completó.");
        return false;
      }
      setMessage(success);
      router.refresh();
      return true;
    } catch {
      setError("No se pudo conectar con el servidor.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  function saveData(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const taxText = data.taxPercent.trim();
    const taxNumber = taxText === "" ? null : Number(taxText);
    if (taxNumber !== null && (!Number.isFinite(taxNumber) || taxNumber < 0 || taxNumber > 100)) {
      setError("El impuesto debe estar entre 0 y 100.");
      return;
    }
    call(
      `/api/catalog/${product.id}`,
      "PATCH",
      {
        brandName: data.brandName || null,
        strength: data.strength || null,
        presentation: data.presentation || null,
        saleUnit: data.saleUnit || null,
        taxPercent: taxNumber,
        isActive: data.isActive,
        isPrescription: data.isPrescription,
        isControlled: data.isControlled,
      },
      "Datos del producto guardados.",
    );
  }

  function submitVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    call(`/api/catalog/${product.id}/verify`, "POST", {
      status: verify.status,
      evidenceType: verify.evidenceType,
      evidenceReference: verify.evidenceReference,
      notes: verify.notes || undefined,
    }, "Verificación registrada.");
  }

  function submitPrice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = Number(priceValue);
    if (!Number.isFinite(value) || value <= 0) {
      setError("El precio debe ser mayor que cero.");
      return;
    }
    call(`/api/catalog/${product.id}/prices`, "POST", { branchId: priceBranch, salePrice: value }, "Precio actualizado.");
    setPriceValue("");
  }

  return (
    <div className="space-y-6">
      {message && <p role="status" className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">{message}</p>}
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <section className="grid gap-6 lg:grid-cols-2">
        <form onSubmit={saveData} className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Datos comerciales</h2>
          <p className="text-xs text-gray-500">
            Completa solo lo que el registro sanitario o la factura respalden. No se inventan marcas, concentraciones ni unidades.
          </p>
          <div className="rounded-lg border border-[var(--vitalis-green-soft)] bg-[var(--vitalis-green-soft)] p-2.5 text-xs text-[var(--vitalis-green-dark)]">
            La marca (laboratorio) viene del registro oficial de MISPAS y no se edita aquí: ya está asignada a todo el catálogo.
          </div>
          {([
            ["brandName", "Marca comercial (opcional)"],
            ["strength", "Concentración"],
            ["presentation", "Presentación (ej. caja x 30 tabletas)"],
            ["saleUnit", "Unidad de venta (ej. tableta, caja, frasco)"],
          ] as const).map(([key, label]) => (
            <label key={key} className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">{label}</span>
              <input
                className={inputClass}
                disabled={!permissions.update}
                maxLength={160}
                value={data[key]}
                onChange={(event) => setData((current) => ({ ...current, [key]: event.target.value }))}
              />
            </label>
          ))}
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-gray-700">Impuesto (%) — vacío = no configurado (exento)</span>
            <input
              type="number"
              min={0}
              max={100}
              step="0.01"
              className={inputClass}
              disabled={!permissions.update}
              value={data.taxPercent}
              onChange={(event) => setData((current) => ({ ...current, taxPercent: event.target.value }))}
            />
          </label>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!permissions.update}
                checked={data.isActive}
                onChange={(event) => setData((current) => ({ ...current, isActive: event.target.checked }))}
              />
              Activo (se puede comprar)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!permissions.update}
                checked={data.isPrescription}
                onChange={(event) => setData((current) => ({ ...current, isPrescription: event.target.checked }))}
              />
              Requiere receta
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                disabled={!permissions.update}
                checked={data.isControlled}
                onChange={(event) => setData((current) => ({ ...current, isControlled: event.target.checked }))}
              />
              Controlado
            </label>
          </div>
          {permissions.update && (
            <button type="submit" disabled={busy} className="rounded-lg bg-[var(--vitalis-green)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--vitalis-green-dark)] disabled:opacity-60">
              Guardar datos
            </button>
          )}
        </form>

        <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Foto del producto</h2>
          <p className="text-xs text-gray-500">
            Sube una foto real del producto (la caja o el frasco que vendes, menos de 3 MB, JPG/PNG/WEBP) o pega la dirección
            de la imagen del fabricante. Sin foto, los listados muestran el ícono según la forma farmacéutica.
          </p>
          <div className="flex items-center gap-4">
            <ProductImage name={product.name} dosageForm={product.dosageForm} imageUrl={product.imageUrl} size="lg" className="shadow-sm" />
            <div className="space-y-2 text-sm">
              {product.imageUrl ? (
                <>
                  <p className="text-xs text-[var(--vitalis-green-dark)]">Foto actual configurada.</p>
                  {permissions.update && (
                    <button type="button" onClick={removeImage} disabled={busy} className="rounded-lg border border-[var(--vitalis-red)] px-3 py-1.5 text-xs font-medium text-[var(--vitalis-red-dark)] transition hover:bg-[var(--vitalis-red-soft)] disabled:opacity-50">
                      Quitar foto actual
                    </button>
                  )}
                </>
              ) : (
                <p className="text-xs text-gray-500">Este producto todavía no tiene foto.</p>
              )}
              {permissions.update && (
                <span className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void uploadImage(file);
                    }}
                    className="block w-48 cursor-pointer rounded-lg border border-gray-300 text-xs file:mr-2 file:cursor-pointer file:rounded-md file:border-0 file:bg-[var(--vitalis-green)] file:px-2.5 file:py-1.5 file:text-xs file:font-semibold file:text-white"
                  />
                  {busy && <span className="text-xs text-gray-500">Guardando…</span>}
                </span>
              )}
            </div>
          </div>
          {permissions.update && (
            <form onSubmit={submitImageUrl} className="grid grid-cols-[1fr_auto] items-end gap-2">
              <label className="block text-sm">
                <span className="mb-1 block text-gray-700">…o pega la dirección de una imagen del fabricante (https://…)</span>
                <input
                  className={inputClass}
                  maxLength={1000}
                  disabled={busy}
                  value={imageUrlDraft}
                  onChange={(event) => setImageUrlDraft(event.target.value)}
                  placeholder="https://laboratorio.com/w/presentacion.jpg"
                />
              </label>
              <button type="submit" disabled={busy || !imageUrlDraft.trim()} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">
                Guardar URL
              </button>
            </form>
          )}
        </section>

        <div className="space-y-6">
          <form onSubmit={submitVerification} className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Verificación</h2>
            <p className="text-xs text-gray-500">
              Para verificar con registro sanitario, el número debe existir en el registro oficial, estar vigente y tener el mismo nombre del producto.
            </p>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Estado</span>
              <select
                className={inputClass}
                disabled={!permissions.verify}
                value={verify.status}
                onChange={(event) => setVerify((current) => ({ ...current, status: event.target.value as typeof verify.status }))}
              >
                <option value="verified">Verificado (apto para vender)</option>
                <option value="needs_review">En revisión (no se vende)</option>
                <option value="pending">Pendiente (no se vende)</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Tipo de evidencia</span>
              <select
                className={inputClass}
                disabled={!permissions.verify}
                value={verify.evidenceType}
                onChange={(event) => setVerify((current) => ({ ...current, evidenceType: event.target.value as typeof verify.evidenceType }))}
              >
                <option value="sanitary_registry">Registro sanitario (número)</option>
                <option value="manual_review">Revisión manual con justificación</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Referencia de la evidencia</span>
              <input
                className={inputClass}
                disabled={!permissions.verify}
                maxLength={200}
                value={verify.evidenceReference}
                onChange={(event) => setVerify((current) => ({ ...current, evidenceReference: event.target.value }))}
                placeholder="Número de registro sanitario o documento revisado"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-gray-700">Justificación (obligatoria en revisión manual)</span>
              <textarea
                className={inputClass}
                disabled={!permissions.verify}
                rows={2}
                maxLength={500}
                value={verify.notes}
                onChange={(event) => setVerify((current) => ({ ...current, notes: event.target.value }))}
              />
            </label>
            {permissions.verify ? (
              <button type="submit" disabled={busy || verify.evidenceReference.trim().length < 3} className="rounded-lg bg-[var(--vitalis-green)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--vitalis-green-dark)] disabled:opacity-60">
                Registrar verificación
              </button>
            ) : (
              <p className="text-xs text-gray-500">Tu rol no puede verificar productos.</p>
            )}
          </form>

          <section className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">Precio de venta por sucursal</h2>
            <ul className="space-y-1 text-sm">
              {branches.length === 0 && <li className="text-gray-500">No tienes sucursales con acceso a precios.</li>}
              {branches.map((branch) => (
                <li key={branch.id} className="flex justify-between border-b pb-1">
                  <span>{branch.name}</span>
                  <span className="font-medium">{branch.currentPrice ? `RD$ ${Number(branch.currentPrice).toFixed(2)}` : "Sin precio"}</span>
                </li>
              ))}
            </ul>
            {permissions.prices && branches.length > 0 && (
              <form onSubmit={submitPrice} className="grid grid-cols-[1fr_auto_auto] items-end gap-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-gray-700">Sucursal</span>
                  <select className={inputClass} value={priceBranch} onChange={(event) => setPriceBranch(event.target.value)}>
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>{branch.name}</option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-gray-700">Precio (RD$, con impuesto)</span>
                  <input
                    type="number"
                    min={0.01}
                    step="0.01"
                    className={inputClass}
                    value={priceValue}
                    onChange={(event) => setPriceValue(event.target.value)}
                  />
                </label>
                <button type="submit" disabled={busy || !priceValue} className="rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:opacity-50">
                  Guardar precio
                </button>
              </form>
            )}
            <p className="text-xs text-gray-500">Al guardar un precio nuevo, el anterior se cierra y queda en el historial.</p>
          </section>
        </div>
      </section>

      {product.isDuplicate && (
        <p className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
          Este producto está marcado como duplicado de otro registro del catálogo. No se vende; el registro principal se conserva.
        </p>
      )}
    </div>
  );
}
