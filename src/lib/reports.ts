import "server-only";

import { db } from "@/src/lib/db";

export const REPORT_TZ = "America/Santo_Domingo";

export const REPORTS = {
  "sales-by-period": "Ventas por período",
  "sales-by-branch": "Ventas por sucursal",
  "top-products": "Productos más vendidos",
  profitability: "Rentabilidad",
  purchases: "Compras",
  "stock-levels": "Existencias",
  expiring: "Próximos a vencer",
  movements: "Movimientos de inventario",
  "branch-performance": "Desempeño por sucursal",
} as const;

export type ReportKey = keyof typeof REPORTS;

export type ReportParams = {
  branchIds: string[];
  from: string;
  to: string;
  days?: number;
};

const dateRange = `
  s.created_at >= ($2::date)::timestamp AT TIME ZONE '${REPORT_TZ}'
  AND s.created_at < (($3::date) + 1)::timestamp AT TIME ZONE '${REPORT_TZ}'`;

/** Ventas completadas agrupadas por día (hora local). */
export async function salesByPeriod(p: ReportParams) {
  const result = await db.query(
    `SELECT to_char(s.created_at AT TIME ZONE '${REPORT_TZ}', 'YYYY-MM-DD') AS day,
            COUNT(*)::int AS sales_count,
            COALESCE(SUM(s.subtotal), 0)::numeric(14,2) AS subtotal,
            COALESCE(SUM(s.discount_total), 0)::numeric(14,2) AS discounts,
            COALESCE(SUM(s.tax_total), 0)::numeric(14,2) AS tax,
            COALESCE(SUM(s.total), 0)::numeric(14,2) AS total
     FROM farmacia.sales s
     WHERE s.branch_id = ANY($1::uuid[]) AND s.status = 'completed' AND ${dateRange}
     GROUP BY 1
     ORDER BY 1`,
    [p.branchIds, p.from, p.to],
  );
  return result.rows;
}

/** Ventas completadas por sucursal. */
export async function salesByBranch(p: ReportParams) {
  const result = await db.query(
    `SELECT b.id AS branch_id, b.name AS branch_name,
            COUNT(s.id)::int AS sales_count,
            COALESCE(SUM(s.total), 0)::numeric(14,2) AS total,
            COALESCE(AVG(s.total), 0)::numeric(14,2) AS average_ticket
     FROM farmacia.branches b
     LEFT JOIN farmacia.sales s ON s.branch_id = b.id AND s.status = 'completed' AND ${dateRange}
     WHERE b.id = ANY($1::uuid[])
     GROUP BY b.id, b.name
     ORDER BY b.name`,
    [p.branchIds, p.from, p.to],
  );
  return result.rows;
}

/** Productos más vendidos por cantidad e ingreso. */
export async function topProducts(p: ReportParams, limit = 50) {
  const result = await db.query(
    `SELECT si.product_id, si.product_name, si.sale_unit,
            SUM(si.quantity)::int AS units,
            COALESCE(SUM(si.line_total), 0)::numeric(14,2) AS revenue
     FROM farmacia.sale_items si
     INNER JOIN farmacia.sales s ON s.id = si.sale_id
     WHERE s.branch_id = ANY($1::uuid[]) AND s.status = 'completed' AND ${dateRange}
     GROUP BY si.product_id, si.product_name, si.sale_unit
     ORDER BY units DESC, revenue DESC
     LIMIT $4`,
    [p.branchIds, p.from, p.to, limit],
  );
  return result.rows;
}

/**
 * Rentabilidad: ingreso sin impuesto menos costo de los lotes vendidos.
 * Las líneas sin costo registrado se cuentan aparte para no presentar un margen engañoso.
 */
export async function profitability(p: ReportParams) {
  const result = await db.query(
    `SELECT b.name AS branch_name, si.product_name,
            SUM(si.quantity)::int AS units,
            COALESCE(SUM(si.line_total - si.tax_amount), 0)::numeric(14,2) AS net_revenue,
            COALESCE(SUM(si.quantity * si.unit_cost), 0)::numeric(14,2) AS cost,
            (COALESCE(SUM(si.line_total - si.tax_amount), 0) - COALESCE(SUM(si.quantity * si.unit_cost), 0))::numeric(14,2) AS gross_margin,
            COUNT(*) FILTER (WHERE si.unit_cost = 0)::int AS lines_without_cost
     FROM farmacia.sale_items si
     INNER JOIN farmacia.sales s ON s.id = si.sale_id
     INNER JOIN farmacia.branches b ON b.id = s.branch_id
     WHERE s.branch_id = ANY($1::uuid[]) AND s.status = 'completed' AND ${dateRange}
     GROUP BY b.name, si.product_name
     ORDER BY gross_margin DESC
     LIMIT 200`,
    [p.branchIds, p.from, p.to],
  );
  return result.rows;
}

/** Órdenes de compra por sucursal y estado, en el rango de fechas. */
export async function purchasesSummary(p: ReportParams) {
  const result = await db.query(
    `SELECT b.name AS branch_name, po.status,
            COUNT(po.id)::int AS orders,
            COALESCE(SUM(po.total_amount), 0)::numeric(14,2) AS total_amount
     FROM farmacia.purchase_orders po
     INNER JOIN farmacia.branches b ON b.id = po.branch_id
     WHERE po.branch_id = ANY($1::uuid[])
       AND po.order_date BETWEEN $2::date AND $3::date
     GROUP BY b.name, po.status
     ORDER BY b.name, po.status`,
    [p.branchIds, p.from, p.to],
  );
  return result.rows;
}

/** Existencias por producto y sucursal, con valor a costo de los lotes vigentes. */
export async function stockLevels(p: ReportParams, limit = 300) {
  const result = await db.query(
    `SELECT b.name AS branch_name, pr.product_name, pr.sale_unit,
            s.quantity_on_hand, s.quantity_reserved,
            (s.quantity_on_hand - s.quantity_reserved) AS available,
            s.minimum_stock, s.reorder_point,
            COALESCE(lots.value, 0)::numeric(14,2) AS stock_value,
            CASE
              WHEN s.quantity_on_hand - s.quantity_reserved <= 0 THEN 'sin_existencias'
              WHEN s.reorder_point IS NOT NULL AND s.quantity_on_hand - s.quantity_reserved <= s.reorder_point THEN 'reponer'
              WHEN s.minimum_stock IS NOT NULL AND s.quantity_on_hand - s.quantity_reserved <= s.minimum_stock THEN 'stock_bajo'
              ELSE 'normal'
            END AS stock_status
     FROM farmacia.inventory_stock s
     INNER JOIN farmacia.branches b ON b.id = s.branch_id
     INNER JOIN farmacia.catalog_products pr ON pr.id = s.product_id
     LEFT JOIN LATERAL (
       SELECT SUM(l.quantity_remaining * COALESCE(l.unit_cost, 0)) AS value
       FROM farmacia.inventory_lots l
       WHERE l.branch_id = s.branch_id AND l.product_id = s.product_id AND l.status = 'available'
     ) lots ON TRUE
     WHERE s.branch_id = ANY($1::uuid[])
       AND (s.quantity_on_hand > 0 OR s.minimum_stock IS NOT NULL OR s.reorder_point IS NOT NULL)
     ORDER BY b.name, pr.product_name
     LIMIT $2`,
    [p.branchIds, limit],
  );
  return result.rows;
}

/** Lotes con existencias que vencen dentro de un número de días (incluye ya vencidos). */
export async function expiringLots(p: ReportParams) {
  const days = Math.min(Math.max(p.days ?? 60, 1), 365);
  const result = await db.query(
    `SELECT b.name AS branch_name, pr.product_name, l.lot_number,
            to_char(l.expiration_date, 'YYYY-MM-DD') AS expiration_date,
            (l.expiration_date - CURRENT_DATE)::int AS days_remaining,
            l.quantity_remaining, l.status,
            (l.quantity_remaining * COALESCE(l.unit_cost, 0))::numeric(14,2) AS value_at_cost
     FROM farmacia.inventory_lots l
     INNER JOIN farmacia.branches b ON b.id = l.branch_id
     INNER JOIN farmacia.catalog_products pr ON pr.id = l.product_id
     WHERE l.branch_id = ANY($1::uuid[])
       AND l.quantity_remaining > 0
       AND l.expiration_date IS NOT NULL
       AND l.expiration_date <= CURRENT_DATE + make_interval(days => $2::int)
       AND l.status IN ('available', 'expired', 'blocked')
     ORDER BY l.expiration_date ASC, pr.product_name
     LIMIT 500`,
    [p.branchIds, days],
  );
  return result.rows;
}

/** Movimientos de inventario en el rango, con usuario y tipo. */
export async function movements(p: ReportParams, limit = 500) {
  const result = await db.query(
    `SELECT b.name AS branch_name, pr.product_name, m.movement_type, m.quantity_delta,
            m.unit_cost, l.lot_number, m.reason,
            to_char(m.created_at AT TIME ZONE '${REPORT_TZ}', 'DD/MM/YYYY HH24:MI') AS created_label,
            TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS user_name
     FROM farmacia.inventory_movements m
     INNER JOIN farmacia.branches b ON b.id = m.branch_id
     INNER JOIN farmacia.catalog_products pr ON pr.id = m.product_id
     LEFT JOIN farmacia.inventory_lots l ON l.id = m.lot_id
     LEFT JOIN farmacia.users u ON u.id = m.created_by
     WHERE m.branch_id = ANY($1::uuid[])
       AND m.created_at >= ($2::date)::timestamp AT TIME ZONE '${REPORT_TZ}'
       AND m.created_at < (($3::date) + 1)::timestamp AT TIME ZONE '${REPORT_TZ}'
     ORDER BY m.created_at DESC
     LIMIT $4`,
    [p.branchIds, p.from, p.to, limit],
  );
  return result.rows;
}

/** Indicadores por sucursal: ventas, anulaciones, transferencias, valor de inventario y lotes por vencer. */
export async function branchPerformance(p: ReportParams) {
  const result = await db.query(
    `SELECT b.id AS branch_id, b.name AS branch_name,
            (SELECT COUNT(*)::int FROM farmacia.sales s
              WHERE s.branch_id = b.id AND s.status = 'completed' AND ${dateRange}) AS sales_count,
            (SELECT COALESCE(SUM(s.total), 0)::numeric(14,2) FROM farmacia.sales s
              WHERE s.branch_id = b.id AND s.status = 'completed' AND ${dateRange}) AS sales_total,
            (SELECT COUNT(*)::int FROM farmacia.sales s
              WHERE s.branch_id = b.id AND s.status = 'cancelled' AND ${dateRange}) AS cancelled_count,
            (SELECT COUNT(*)::int FROM farmacia.transfers t
              WHERE t.origin_branch_id = b.id AND t.requested_at >= ($2::date)::timestamp AT TIME ZONE '${REPORT_TZ}'
                AND t.requested_at < (($3::date) + 1)::timestamp AT TIME ZONE '${REPORT_TZ}') AS transfers_out,
            (SELECT COUNT(*)::int FROM farmacia.transfers t
              WHERE t.destination_branch_id = b.id AND t.requested_at >= ($2::date)::timestamp AT TIME ZONE '${REPORT_TZ}'
                AND t.requested_at < (($3::date) + 1)::timestamp AT TIME ZONE '${REPORT_TZ}') AS transfers_in,
            (SELECT COALESCE(SUM(l.quantity_remaining * COALESCE(l.unit_cost, 0)), 0)::numeric(14,2)
              FROM farmacia.inventory_lots l WHERE l.branch_id = b.id AND l.status = 'available') AS inventory_value,
            (SELECT COUNT(*)::int FROM farmacia.inventory_lots l
              WHERE l.branch_id = b.id AND l.status = 'available' AND l.quantity_remaining > 0
                AND l.expiration_date IS NOT NULL AND l.expiration_date <= CURRENT_DATE + 60) AS expiring_lots
     FROM farmacia.branches b
     WHERE b.is_active = TRUE AND b.id = ANY($1::uuid[])
     ORDER BY b.name`,
    [p.branchIds, p.from, p.to],
  );
  return result.rows;
}

export async function runReport(key: ReportKey, p: ReportParams) {
  switch (key) {
    case "sales-by-period": return salesByPeriod(p);
    case "sales-by-branch": return salesByBranch(p);
    case "top-products": return topProducts(p);
    case "profitability": return profitability(p);
    case "purchases": return purchasesSummary(p);
    case "stock-levels": return stockLevels(p);
    case "expiring": return expiringLots(p);
    case "movements": return movements(p);
    case "branch-performance": return branchPerformance(p);
  }
}

/**
 * Columnas visibles de cada reporte (sin identificadores internos).
 * La pantalla y el exportado a CSV usan esta misma lista.
 */
export const REPORT_COLUMNS: Record<ReportKey, string[]> = {
  "sales-by-period": ["day", "sales_count", "subtotal", "discounts", "tax", "total"],
  "sales-by-branch": ["branch_name", "sales_count", "total", "average_ticket"],
  "top-products": ["product_name", "sale_unit", "units", "revenue"],
  profitability: ["branch_name", "product_name", "units", "net_revenue", "cost", "gross_margin", "lines_without_cost"],
  purchases: ["branch_name", "status", "orders", "total_amount"],
  "stock-levels": [
    "branch_name", "product_name", "sale_unit", "quantity_on_hand", "quantity_reserved", "available",
    "minimum_stock", "reorder_point", "stock_value", "stock_status",
  ],
  expiring: ["branch_name", "product_name", "lot_number", "expiration_date", "days_remaining", "quantity_remaining", "status", "value_at_cost"],
  movements: ["branch_name", "product_name", "movement_type", "quantity_delta", "unit_cost", "lot_number", "reason", "created_label", "user_name"],
  "branch-performance": ["branch_name", "sales_count", "sales_total", "cancelled_count", "transfers_out", "transfers_in", "inventory_value", "expiring_lots"],
};
