"use client";

import { useCallback, useEffect, useState } from "react";

type Supplier = {
  id: string;
  name: string;
  commercial_name: string | null;
  tax_id: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  payment_terms: string | null;
  notes: string | null;
  is_active: boolean;
  purchase_orders_count: number;
};

const emptyForm = {
  name: "",
  commercialName: "",
  taxId: "",
  contactName: "",
  phone: "",
  email: "",
  address: "",
  paymentTerms: "",
  notes: "",
};

export default function SuppliersManager() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/suppliers?search=${encodeURIComponent(search)}`, {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Error consultando suplidores");
      setSuppliers(data.suppliers || []);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "No fue posible cargar los suplidores.");
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 250);
    return () => clearTimeout(timer);
  }, [load]);

  function change(field: keyof typeof emptyForm, value: string) {
    setForm(current => ({ ...current, [field]: value }));
  }

  function startEdit(s: Supplier) {
    setEditing(s.id);
    setForm({
      name: s.name || "",
      commercialName: s.commercial_name || "",
      taxId: s.tax_id || "",
      contactName: s.contact_name || "",
      phone: s.phone || "",
      email: s.email || "",
      address: s.address || "",
      paymentTerms: s.payment_terms || "",
      notes: s.notes || "",
    });
    setShowForm(true);
    setMessage("");
  }

  function resetForm() {
    setForm(emptyForm);
    setEditing(null);
    setShowForm(false);
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage("");

    try {
      const response = await fetch(
        editing ? `/api/suppliers/${editing}` : "/api/suppliers",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No fue posible guardar.");

      setMessage(editing ? "Suplidor actualizado correctamente." : "Suplidor registrado correctamente.");
      resetForm();
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Error guardando suplidor.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(s: Supplier) {
    const action = s.is_active ? "desactivar" : "activar";
    if (!window.confirm(`¿Deseas ${action} a ${s.name}?`)) return;

    try {
      const response = await fetch(`/api/suppliers/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: s.name,
          commercialName: s.commercial_name,
          taxId: s.tax_id,
          contactName: s.contact_name,
          phone: s.phone,
          email: s.email,
          address: s.address,
          paymentTerms: s.payment_terms,
          notes: s.notes,
          isActive: !s.is_active,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "No fue posible actualizar.");
      setMessage(`Suplidor ${s.is_active ? "desactivado" : "activado"} correctamente.`);
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Error actualizando suplidor.");
    }
  }

  const inputClass = "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-500";
  const labelClass = "mb-1 block text-sm font-medium text-gray-700";

  return (
    <main className="space-y-6 p-4 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Suplidores</h1>
          <p className="mt-1 text-sm text-gray-500">Directorio comercial de proveedores de Farmacia Vitalis.</p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true); setMessage(""); }}
          className="rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
        >
          + Nuevo suplidor
        </button>
      </div>

      {message && (
        <div role="status" className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          {message}
        </div>
      )}

      {showForm && (
        <form onSubmit={save} className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900">
              {editing ? "Editar suplidor" : "Registrar suplidor"}
            </h2>
            <button type="button" onClick={resetForm} className="text-sm text-gray-500 hover:text-gray-900">
              Cerrar
            </button>
          </div>

          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <label>
              <span className={labelClass}>Nombre legal *</span>
              <input required maxLength={180} className={inputClass} value={form.name} onChange={e => change("name", e.target.value)} />
            </label>
            <label>
              <span className={labelClass}>Nombre comercial</span>
              <input maxLength={180} className={inputClass} value={form.commercialName} onChange={e => change("commercialName", e.target.value)} />
            </label>
            <label>
              <span className={labelClass}>RNC / Identificación fiscal</span>
              <input maxLength={40} className={inputClass} value={form.taxId} onChange={e => change("taxId", e.target.value)} />
            </label>
            <label>
              <span className={labelClass}>Persona de contacto</span>
              <input maxLength={160} className={inputClass} value={form.contactName} onChange={e => change("contactName", e.target.value)} />
            </label>
            <label>
              <span className={labelClass}>Teléfono</span>
              <input maxLength={40} className={inputClass} value={form.phone} onChange={e => change("phone", e.target.value)} />
            </label>
            <label>
              <span className={labelClass}>Correo electrónico</span>
              <input type="email" maxLength={180} className={inputClass} value={form.email} onChange={e => change("email", e.target.value)} />
            </label>
            <label>
              <span className={labelClass}>Condiciones de pago</span>
              <input maxLength={120} placeholder="Ej. Crédito 30 días" className={inputClass} value={form.paymentTerms} onChange={e => change("paymentTerms", e.target.value)} />
            </label>
            <label className="md:col-span-2">
              <span className={labelClass}>Dirección</span>
              <input maxLength={2000} className={inputClass} value={form.address} onChange={e => change("address", e.target.value)} />
            </label>
            <label className="md:col-span-2 lg:col-span-3">
              <span className={labelClass}>Notas internas</span>
              <textarea rows={2} maxLength={5000} className={inputClass} value={form.notes} onChange={e => change("notes", e.target.value)} />
            </label>
          </div>

          <div className="flex gap-2">
            <button disabled={saving} className="rounded-lg bg-blue-700 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
              {saving ? "Guardando..." : editing ? "Guardar cambios" : "Registrar suplidor"}
            </button>
            <button type="button" onClick={resetForm} className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm">
              Cancelar
            </button>
          </div>
        </form>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por nombre, RNC, contacto..."
          className={`${inputClass} max-w-xl`}
        />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="border-b bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-3">Suplidor</th>
                <th className="px-3 py-3">RNC</th>
                <th className="px-3 py-3">Contacto</th>
                <th className="px-3 py-3">Compras</th>
                <th className="px-3 py-3">Estado</th>
                <th className="px-3 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={6} className="p-8 text-center text-gray-500">Cargando suplidores...</td></tr>
              ) : suppliers.length === 0 ? (
                <tr><td colSpan={6} className="p-8 text-center text-gray-500">No hay suplidores registrados.</td></tr>
              ) : suppliers.map(s => (
                <tr key={s.id} className="hover:bg-gray-50">
                  <td className="px-3 py-4">
                    <div className="font-semibold text-gray-900">{s.name}</div>
                    {s.commercial_name && <div className="text-xs text-gray-500">{s.commercial_name}</div>}
                  </td>
                  <td className="px-3 py-4">{s.tax_id || "—"}</td>
                  <td className="px-3 py-4">
                    <div>{s.contact_name || "—"}</div>
                    <div className="text-xs text-gray-500">{s.phone || s.email || ""}</div>
                  </td>
                  <td className="px-3 py-4">{s.purchase_orders_count}</td>
                  <td className="px-3 py-4">
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${s.is_active ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}`}>
                      {s.is_active ? "Activo" : "Inactivo"}
                    </span>
                  </td>
                  <td className="px-3 py-4 text-right">
                    <button onClick={() => startEdit(s)} className="mr-3 font-medium text-blue-700 hover:underline">Editar</button>
                    <button onClick={() => void toggleActive(s)} className="font-medium text-gray-600 hover:underline">
                      {s.is_active ? "Desactivar" : "Activar"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-gray-500">{suppliers.length} suplidor(es)</p>
      </div>
    </main>
  );
}