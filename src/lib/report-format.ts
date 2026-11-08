/**
 * Formato compartido de reportes: etiquetas de columnas, etiquetas de estados y
 * formateo para la pantalla y para el CSV exportado. Así la pantalla y el archivo
 * usan exactamente los mismos encabezados.
 */

export const COLUMN_LABELS: Record<string, string> = {
  day: "Día",
  sales_count: "Ventas",
  subtotal: "Subtotal",
  discounts: "Descuentos",
  tax: "Impuesto",
  total: "Total",
  branch_name: "Sucursal",
  average_ticket: "Ticket promedio",
  product_name: "Producto",
  sale_unit: "Unidad",
  units: "Unidades",
  revenue: "Ingreso",
  net_revenue: "Ingreso neto",
  cost: "Costo",
  gross_margin: "Margen bruto",
  lines_without_cost: "Líneas sin costo",
  status: "Estado",
  orders: "Órdenes",
  total_amount: "Monto",
  quantity_on_hand: "En existencia",
  quantity_reserved: "Reservado",
  available: "Disponible",
  minimum_stock: "Mínimo",
  reorder_point: "Punto de reposición",
  stock_value: "Valor a costo",
  stock_status: "Situación",
  lot_number: "Lote",
  expiration_date: "Vence",
  days_remaining: "Días restantes",
  quantity_remaining: "Restante",
  value_at_cost: "Valor a costo",
  movement_type: "Tipo",
  quantity_delta: "Cantidad",
  unit_cost: "Costo unitario",
  reason: "Motivo",
  created_label: "Fecha",
  user_name: "Usuario",
  cancelled_count: "Anuladas",
  sales_total: "Venta total",
  transfers_out: "Transferencias salientes",
  transfers_in: "Transferencias entrantes",
  inventory_value: "Valor de inventario",
  expiring_lots: "Lotes por vencer",
};

export const MONEY_COLUMNS = new Set([
  "subtotal", "discounts", "tax", "total", "average_ticket", "revenue", "net_revenue", "cost",
  "gross_margin", "total_amount", "stock_value", "value_at_cost", "unit_cost", "sales_total", "inventory_value",
]);

export const STATUS_LABELS: Record<string, string> = {
  sin_existencias: "Sin existencias",
  reponer: "Reponer",
  stock_bajo: "Stock bajo",
  normal: "Normal",
  draft: "Borrador",
  ordered: "Ordenada",
  partially_received: "Recepción parcial",
  received: "Recibida",
  cancelled: "Cancelada",
  completed: "Completada",
  available: "Disponible",
  expired: "Vencido",
  blocked: "Bloqueado",
  depleted: "Agotado",
};

export function describeStatus(value: unknown): string {
  return STATUS_LABELS[String(value)] ?? String(value);
}

/** Formato para la pantalla: moneda legible, etiquetas de estado y separadores. */
export function format(column: string, value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (column === "created_label") return String(value);
  if (MONEY_COLUMNS.has(column)) {
    return new Intl.NumberFormat("es-DO", { style: "currency", currency: "DOP", minimumFractionDigits: 2 }).format(
      Number(value) || 0,
    );
  }
  if (column === "stock_status" || column === "status") return describeStatus(value);
  if (typeof value === "string" && /^-?\d+\.\d+$/.test(value)) {
    return Number(value).toLocaleString("es-DO", { maximumFractionDigits: 3 });
  }
  return String(value);
}

/**
 * Formato para el CSV: los números quedan como números (sin símbolo de moneda ni
 * separadores de miles) para que Excel los calcule; los estados como etiqueta.
 */
export function formatCsvCell(column: string, value: unknown): string {
  if (value === null || value === undefined) return "";
  if (column === "stock_status" || column === "status") return describeStatus(value);
  return String(value);
}
