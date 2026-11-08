export const instant = false;
import { notFound } from "next/navigation";
import { db } from "@/src/lib/db";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import { canOperateBranch } from "@/src/lib/access";
import { loadSaleDetail } from "@/src/lib/sales";
import AppShell from "@/src/components/AppShell";
import SaleActions from "./SaleActions";


const money = (value: string | number) =>
  new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP", minimumFractionDigits: 2 }).format(
    Number(value) || 0,
  );

const METHOD_LABELS: Record<string, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  bank_transfer: "Transferencia",
  other: "Otro",
};

export default async function SaleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePagePermission("sales.view");
  const { id } = await params;

  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const head = await db.query<{ branch_id: string }>(`SELECT branch_id FROM farmacia.sales WHERE id = $1`, [id]);
  if (head.rows.length === 0) notFound();

  if (!(await canOperateBranch(session, "sales.view", head.rows[0].branch_id))) notFound();

  const sale = await loadSaleDetail(id);
  if (!sale) notFound();

  const canCancel =
    sale.status === "completed" && (await canOperateBranch(session, "sales.cancel", sale.branch_id));

  const pharmacyName = await db.query<{ value: string }>(
    `SELECT value FROM farmacia.app_settings WHERE key = 'pharmacy_name'`,
  );
  const footer = await db.query<{ value: string }>(
    `SELECT value FROM farmacia.app_settings WHERE key = 'receipt_footer'`,
  );

  return (
    <AppShell session={session} activeItem="sales">
      <main className="mx-auto max-w-3xl space-y-6 p-4 md:p-8 print:max-w-none print:p-0">
        <SaleActions saleId={sale.id} canCancel={canCancel} />

        <article className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm print:border-0 print:shadow-none">
          <header className="border-b pb-4 text-center">
            <h1 className="text-xl font-bold">{pharmacyName.rows[0]?.value ?? "Farmacia"}</h1>
            <p className="text-sm text-gray-600">{sale.branch_name}</p>
            <p className="mt-2 text-sm font-semibold">{sale.sale_number}</p>
            <p className="text-xs text-gray-500">
              {new Date(sale.created_at).toLocaleString("es-DO", { timeZone: "America/Santo_Domingo" })}
            </p>
            <p className="mt-1 text-xs text-gray-500">Cajero: {sale.cashier_name}</p>
            <p className="text-xs text-gray-500">Cliente: {sale.customer_name ?? "Consumidor final"}</p>
            {sale.status === "cancelled" && (
              <p className="mt-3 rounded bg-red-50 p-2 text-sm font-semibold text-red-700">
                VENTA ANULADA · {sale.cancelled_at ? new Date(sale.cancelled_at).toLocaleDateString("es-DO") : ""}
                <br />
                Motivo: {sale.cancel_reason}
              </p>
            )}
          </header>

          <table className="my-4 w-full text-sm">
            <thead className="border-b text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="py-2">Producto</th>
                <th className="py-2 text-right">Cant.</th>
                <th className="py-2 text-right">Precio</th>
                <th className="py-2 text-right">Desc.</th>
                <th className="py-2 text-right">Importe</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {sale.items.map((item) => (
                <tr key={item.id}>
                  <td className="py-2">
                    {item.product_name}
                    <span className="block text-xs text-gray-500">{item.sale_unit}</span>
                    {Number(item.discount_amount) > 0 && (
                      <span className="block text-xs text-gray-500">Descuento: {item.discount_reason}</span>
                    )}
                  </td>
                  <td className="py-2 text-right">{item.quantity}</td>
                  <td className="py-2 text-right">{money(Number(item.unit_price))}</td>
                  <td className="py-2 text-right">{money(Number(item.discount_amount))}</td>
                  <td className="py-2 text-right">{money(Number(item.line_total))}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-sm">
            <dt className="text-gray-600">Subtotal</dt>
            <dd className="text-right">{money(Number(sale.subtotal))}</dd>
            <dt className="text-gray-600">Descuentos</dt>
            <dd className="text-right">{money(Number(sale.discount_total))}</dd>
            <dt className="text-gray-600">Impuesto incluido</dt>
            <dd className="text-right">{money(Number(sale.tax_total))}</dd>
            <dt className="font-bold">Total</dt>
            <dd className="text-right font-bold">{money(Number(sale.total))}</dd>
          </dl>

          <div className="mt-4 border-t pt-3 text-sm">
            <p className="font-medium">Pagos</p>
            {sale.payments.map((payment, index) => (
              <p key={index}>
                {METHOD_LABELS[payment.method] ?? payment.method}: {money(Number(payment.amount))}
                {payment.reference ? ` (ref. ${payment.reference})` : ""}
              </p>
            ))}
            <p>Cambio: {money(Number(sale.change_amount))}</p>
          </div>

          <footer className="mt-6 border-t pt-3 text-center text-xs text-gray-500">
            {footer.rows[0]?.value ?? ""}
          </footer>
        </article>
      </main>
    </AppShell>
  );
}
