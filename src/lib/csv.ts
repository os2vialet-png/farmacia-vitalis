/**
 * Serialización CSV (RFC 4180) para la exportación de reportes.
 * Funciones puras: las pruebas unitarias las cubren en scripts/qa/unit.test.ts.
 */

/** Escapa una celda: comillas, comas, saltos de línea y retornos de carro. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** Serializa una tabla completa. Delimitador coma, fin de línea CRLF (compatible con Excel). */
export function serializeCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvCell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
