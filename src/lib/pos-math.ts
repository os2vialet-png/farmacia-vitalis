// Cálculos del punto de venta. Funciones puras, sin acceso a base de datos.
// Todo el dinero se opera en centavos enteros para evitar errores de coma flotante.
//
// Convención de precios: el precio de venta (product_branch_prices.sale_price) INCLUYE el impuesto.
// Para un producto con tasa r > 0: base = neto / (1 + r) y impuesto = neto - base.
// Un producto sin tasa configurada (NULL) se trata como exento: impuesto = 0.

export type LotAvailability = {
  lotId: string;
  remaining: number;
  unitCost: number;
  expirationDate: string;
};

export type LotAllocation = {
  lotId: string;
  quantity: number;
  unitCost: number;
};

/**
 * Reparte una cantidad entre lotes en orden FIFO (primero el que vence antes).
 * Devuelve null si los lotes no alcanzan. No modifica la lista recibida.
 */
export function allocateFifo(lots: LotAvailability[], quantity: number): LotAllocation[] | null {
  if (!Number.isInteger(quantity) || quantity <= 0) return null;

  const ordered = [...lots].sort((a, b) =>
    a.expirationDate === b.expirationDate ? 0 : a.expirationDate < b.expirationDate ? -1 : 1,
  );

  let needed = quantity;
  const allocations: LotAllocation[] = [];

  for (const lot of ordered) {
    if (needed === 0) break;
    const take = Math.min(lot.remaining, needed);
    if (take > 0) {
      allocations.push({ lotId: lot.lotId, quantity: take, unitCost: lot.unitCost });
      needed -= take;
    }
  }

  return needed === 0 ? allocations : null;
}

/** Convierte un importe a centavos enteros. Lanza error si no es un número finito. */
export function toCents(value: number | string): number {
  const numeric = typeof value === "string" ? Number(value) : value;

  if (!Number.isFinite(numeric)) {
    throw new RangeError("Importe no numérico.");
  }

  return Math.round(numeric * 100);
}

export function centsToDecimal(cents: number): string {
  return (cents / 100).toFixed(2);
}

export type LineInput = {
  unitPriceCents: number;
  quantity: number;
  discountCents: number;
  taxRate: number;
};

export type LineTotals = {
  grossCents: number;
  discountCents: number;
  baseCents: number;
  taxCents: number;
  totalCents: number;
};

export function computeLine(input: LineInput): LineTotals {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new RangeError("La cantidad debe ser un entero mayor que cero.");
  }

  if (input.unitPriceCents < 0) {
    throw new RangeError("El precio no puede ser negativo.");
  }

  if (input.taxRate < 0 || input.taxRate > 1) {
    throw new RangeError("La tasa de impuesto debe estar entre 0 y 1.");
  }

  const grossCents = input.unitPriceCents * input.quantity;

  if (input.discountCents < 0 || input.discountCents > grossCents) {
    throw new RangeError("El descuento no puede ser negativo ni mayor que el importe de la línea.");
  }

  const netCents = grossCents - input.discountCents;

  if (input.taxRate === 0) {
    return {
      grossCents,
      discountCents: input.discountCents,
      baseCents: netCents,
      taxCents: 0,
      totalCents: netCents,
    };
  }

  const baseCents = Math.round(netCents / (1 + input.taxRate));

  return {
    grossCents,
    discountCents: input.discountCents,
    baseCents,
    taxCents: netCents - baseCents,
    totalCents: netCents,
  };
}

/**
 * Valida el pago y devuelve el cambio. El cambio solo puede entregarse
 * en la parte pagada en efectivo.
 */
export function computeChange(paidCents: number, totalCents: number, cashCents: number): number {
  if (paidCents < totalCents) {
    throw new RangeError("El pago es menor que el total de la venta.");
  }

  const change = paidCents - totalCents;

  if (change > cashCents) {
    throw new RangeError("El cambio solo puede entregarse en efectivo. Ajusta los métodos de pago.");
  }

  return change;
}

/** Cantidad vendible = lo que hay en existencias libres y en lotes vigentes, lo menor de ambos. */
export function sellableQuantity(onHand: number, reserved: number, lotsRemaining: number): number {
  return Math.max(0, Math.min(onHand - reserved, lotsRemaining));
}
