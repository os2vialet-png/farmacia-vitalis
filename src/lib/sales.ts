import "server-only";

import type { Queryable } from "@/src/lib/audit";
import { db } from "@/src/lib/db";

export type SaleDetail = {
  id: string;
  sale_number: string;
  branch_id: string;
  branch_name: string;
  customer_id: string | null;
  customer_name: string | null;
  status: "completed" | "cancelled";
  subtotal: string;
  discount_total: string;
  tax_total: string;
  total: string;
  amount_paid: string;
  change_amount: string;
  currency: string;
  notes: string | null;
  cashier_name: string;
  created_at: string;
  cancel_reason: string | null;
  cancelled_at: string | null;
  cancelled_by_name: string | null;
  items: Array<{
    id: string;
    product_id: string;
    product_name: string;
    sale_unit: string;
    quantity: number;
    unit_price: string;
    discount_amount: string;
    discount_reason: string | null;
    tax_rate: string;
    tax_amount: string;
    line_total: string;
  }>;
  payments: Array<{ method: string; amount: string; reference: string | null }>;
};

/** Carga la venta completa con sus líneas y pagos. Devuelve null si no existe. */
export async function loadSaleDetail(saleId: string, executor: Queryable = db): Promise<SaleDetail | null> {
  const head = await executor.query(
    `SELECT
       s.id, s.sale_number, s.branch_id, b.name AS branch_name,
       s.customer_id, c.full_name AS customer_name,
       s.status, s.subtotal, s.discount_total, s.tax_total, s.total,
       s.amount_paid, s.change_amount, s.currency, s.notes,
       TRIM(CONCAT(cu.first_name, ' ', cu.last_name)) AS cashier_name,
       s.created_at, s.cancel_reason, s.cancelled_at,
       TRIM(CONCAT(cn.first_name, ' ', cn.last_name)) AS cancelled_by_name
     FROM farmacia.sales s
     INNER JOIN farmacia.branches b ON b.id = s.branch_id
     INNER JOIN farmacia.users cu ON cu.id = s.cashier_id
     LEFT JOIN farmacia.customers c ON c.id = s.customer_id
     LEFT JOIN farmacia.users cn ON cn.id = s.cancelled_by
     WHERE s.id = $1`,
    [saleId],
  ) as { rows: Omit<SaleDetail, "items" | "payments">[] };

  if (head.rows.length === 0) return null;

  const items = await executor.query(
    `SELECT id, product_id, product_name, sale_unit, quantity, unit_price,
            discount_amount, discount_reason, tax_rate, tax_amount, line_total
     FROM farmacia.sale_items
     WHERE sale_id = $1
     ORDER BY created_at, product_name`,
    [saleId],
  ) as { rows: SaleDetail["items"] };

  const payments = await executor.query(
    `SELECT method, amount, reference
     FROM farmacia.sale_payments
     WHERE sale_id = $1
     ORDER BY id`,
    [saleId],
  ) as { rows: SaleDetail["payments"] };

  return { ...head.rows[0], items: items.rows, payments: payments.rows };
}
