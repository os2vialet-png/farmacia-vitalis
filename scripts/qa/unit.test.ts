/**
 * Pruebas unitarias de lógica pura (sin base de datos ni servidor).
 *   npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allocateFifo,
  centsToDecimal,
  computeChange,
  computeLine,
  sellableQuantity,
  toCents,
} from "../../src/lib/pos-math";
import { validatePasswordPolicy } from "../../src/lib/auth/policy";
import { csvCell, serializeCsv } from "../../src/lib/csv";

test("toCents redondea correctamente importes con decimales", () => {
  assert.equal(toCents("100.00"), 10000);
  assert.equal(toCents(0.1 + 0.2), 30);
  assert.equal(toCents("19.995"), 2000);
  assert.throws(() => toCents("abc"));
});

test("centsToDecimal devuelve dos decimales", () => {
  assert.equal(centsToDecimal(8475), "84.75");
  assert.equal(centsToDecimal(0), "0.00");
});

test("línea con impuesto incluido del 18 %", () => {
  const line = computeLine({ unitPriceCents: 10000, quantity: 1, discountCents: 0, taxRate: 0.18 });
  assert.equal(line.totalCents, 10000);
  assert.equal(line.baseCents, 8475);
  assert.equal(line.taxCents, 1525);
  assert.equal(line.baseCents + line.taxCents, line.totalCents);
});

test("línea exenta: sin impuesto", () => {
  const line = computeLine({ unitPriceCents: 2550, quantity: 4, discountCents: 200, taxRate: 0 });
  assert.equal(line.grossCents, 10200);
  assert.equal(line.totalCents, 10000);
  assert.equal(line.taxCents, 0);
});

test("descuento mayor que la línea o cantidad inválida se rechazan", () => {
  assert.throws(() => computeLine({ unitPriceCents: 1000, quantity: 1, discountCents: 1001, taxRate: 0 }));
  assert.throws(() => computeLine({ unitPriceCents: 1000, quantity: 0, discountCents: 0, taxRate: 0 }));
  assert.throws(() => computeLine({ unitPriceCents: 1000, quantity: 1.5, discountCents: 0, taxRate: 0 }));
  assert.throws(() => computeLine({ unitPriceCents: 1000, quantity: 1, discountCents: 0, taxRate: 1.5 }));
});

test("FIFO toma primero el lote que vence antes", () => {
  const allocation = allocateFifo(
    [
      { lotId: "B", remaining: 5, unitCost: 10, expirationDate: "2028-06-30" },
      { lotId: "A", remaining: 3, unitCost: 8, expirationDate: "2027-01-31" },
    ],
    6,
  );
  assert.deepEqual(allocation, [
    { lotId: "A", quantity: 3, unitCost: 8 },
    { lotId: "B", quantity: 3, unitCost: 10 },
  ]);
});

test("FIFO devuelve null si los lotes no alcanzan", () => {
  assert.equal(allocateFifo([{ lotId: "A", remaining: 2, unitCost: 1, expirationDate: "2027-01-01" }], 3), null);
  assert.equal(allocateFifo([], 1), null);
});

test("cambio solo se entrega en efectivo", () => {
  assert.equal(computeChange(60000, 50000, 60000), 10000);
  assert.throws(() => computeChange(40000, 50000, 40000));
  assert.throws(() => computeChange(60000, 50000, 0));
});

test("cantidad vendible es el menor entre existencias libres y lotes vigentes", () => {
  assert.equal(sellableQuantity(10, 2, 20), 8);
  assert.equal(sellableQuantity(10, 0, 4), 4);
  assert.equal(sellableQuantity(3, 5, 10), 0);
});

test("política de contraseñas", () => {
  assert.notEqual(validatePasswordPolicy("corta1", "ana"), null);
  assert.notEqual(validatePasswordPolicy("soloLetrasSinNumero", "ana"), null);
  assert.notEqual(validatePasswordPolicy("123456789012345", "ana"), null);
  assert.notEqual(validatePasswordPolicy("password1234", "ana"), null);
  assert.notEqual(validatePasswordPolicy("Farmacia2026!!", "ana"), null);
  assert.notEqual(validatePasswordPolicy("mi-usuario-ana-2026", "ana"), null);
  assert.equal(validatePasswordPolicy("Mangos-del-Cibao-27", "ana"), null);
});

test("CSV: celda nula, números sin cambios y escape de separadores", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(1200.5), "1200.5");
  assert.equal(csvCell("Caja x 10"), "Caja x 10");
  assert.equal(csvCell('Motivo con, coma'), '"Motivo con, coma"');
  assert.equal(csvCell('Con "comillas"'), '"Con ""comillas"""');
  assert.equal(csvCell("línea\nsalto"), '"línea\nsalto"');
});

test("CSV: tabla completa con CRLF y fila final", () => {
  const csv = serializeCsv(
    ["Producto", "Ventas"],
    [["Amoxil 500, caja", 3], ["Sencillo", "Sin notas"]],
  );
  assert.equal(csv, 'Producto,Ventas\r\n"Amoxil 500, caja",3\r\nSencillo,Sin notas\r\n');
});
