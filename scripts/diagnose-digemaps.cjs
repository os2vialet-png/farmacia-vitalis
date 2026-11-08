const fs = require("node:fs");
const { Transform } = require("node:stream");
const { TextDecoder } = require("node:util");
const { parse } = require("csv-parse");

const FILE = "database/imports/Registro-Sanitario-Medicamentos-Productos-Farmaceuticos-MISPAS-2018-2026.csv";

function clean(v) {
  return String(v ?? "").trim();
}

function valid(v) {
  return !["", "N/D", "ND", "NO DISPONIBLE"].includes(clean(v).toUpperCase());
}

function parseDate(value) {
  const text = clean(value);
  if (!valid(text)) return null;

  const separator = text.includes("/") ? "/" : "-";
  const parts = text.split(separator);

  if (parts.length !== 3) return null;
  if (!parts.every(p => p.length > 0 && [...p].every(c => c >= "0" && c <= "9"))) return null;

  let day, month, year;

  if (parts[0].length === 4) {
    year = Number(parts[0]);
    month = Number(parts[1]);
    day = Number(parts[2]);
  } else {
    day = Number(parts[0]);
    month = Number(parts[1]);
    year = Number(parts[2]);
  }

  if (year < 1900 || year > 2100) return null;

  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return null;

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

async function main() {
  const decoder = new TextDecoder("windows-1252");
  const decodeStream = new Transform({
    transform(chunk, enc, cb) {
      try { cb(null, decoder.decode(chunk, { stream: true })); }
      catch (e) { cb(e); }
    },
    flush(cb) {
      try { cb(null, decoder.decode()); }
      catch (e) { cb(e); }
    }
  });

  let headers = [];
  let total = 0;
  let medicines = 0;
  let invalid = 0;
  let empty = 0;
  const samples = [];

  const parser = fs.createReadStream(FILE)
    .pipe(decodeStream)
    .pipe(parse({
      delimiter: ";",
      bom: true,
      columns: h => {
        headers = h.map(clean);
        while (headers.length && !headers[headers.length - 1]) headers.pop();
        return headers;
      },
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true
    }));

  for await (const row of parser) {
    total++;

    if (clean(row["Tipo de producto"]).toUpperCase() !== "MEDICAMENTOS") continue;
    medicines++;

    const raw = row["Fecha Expiracion"];

    if (!valid(raw)) {
      empty++;
      continue;
    }

    const parsed = parseDate(raw);

    if (!parsed) {
      invalid++;
      if (samples.length < 30) {
        samples.push({
          fila: total + 1,
          fecha: raw,
          json: JSON.stringify(raw),
          caracteres: [...String(raw)].map(c => c.charCodeAt(0))
        });
      }
    }
  }

  console.log("\n========== ENCABEZADOS CSV ==========");
  console.log(JSON.stringify(headers, null, 2));
  console.log("\n========== RESULTADOS ==========");
  console.log({ total, medicines, invalid, empty });
  console.log("\n========== MUESTRA DE FECHAS RECHAZADAS ==========");
  console.log(JSON.stringify(samples, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});