const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("csv-parse");

const file = path.resolve(
  "database/imports/Registro-Sanitario-Medicamentos-Productos-Farmaceuticos-MISPAS-2018-2026.csv"
);

if (!fs.existsSync(file)) {
  console.error("ERROR: No se encuentra el CSV:", file);
  process.exit(1);
}

function clean(value) {
  return String(value ?? "").trim();
}

function valid(value) {
  return !["", "N/D", "ND", "NO DISPONIBLE"].includes(
    clean(value).toUpperCase()
  );
}

function normalize(value) {
  return clean(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

async function main() {
  const stats = {
    total: 0,
    types: {},
    statuses: {},
    medicineStatuses: {},
    missing: {
      registration: 0,
      productName: 0,
      ingredient: 0,
      manufacturer: 0,
      distributor: 0,
      package: 0,
      dosageForm: 0
    },
    medicines: 0,
    currentMedicines: 0,
    currentUnique: new Set(),
    exactRows: new Set(),
    duplicateRows: 0,
    invalidMedicineNames: 0
  };

  const parser = fs.createReadStream(file).pipe(
    parse({
      delimiter: ";",
      bom: true,
      encoding: "latin1",
      columns: headers => {
        const result = headers.map(h => clean(h));
        while (result.length && !result[result.length - 1]) {
          result.pop();
        }
        return result;
      },
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true
    })
  );

  for await (const row of parser) {
    stats.total++;

    const type = clean(row["Tipo de producto"]) || "(SIN TIPO)";
    const status = clean(row["Estatus"]) || "(SIN ESTATUS)";

    stats.types[type] = (stats.types[type] || 0) + 1;
    stats.statuses[status] = (stats.statuses[status] || 0) + 1;

    if (type.toUpperCase() !== "MEDICAMENTOS") continue;

    stats.medicines++;

    stats.medicineStatuses[status] =
      (stats.medicineStatuses[status] || 0) + 1;

    for (const [key, field] of [
      ["registration", "Registro Sanitario"],
      ["productName", "NombreProducto"],
      ["ingredient", "Principio Activo"],
      ["manufacturer", "Fabricante"],
      ["distributor", "Distribuidora"],
      ["package", "Empaque"],
      ["dosageForm", "Forma Farmaceutica"]
    ]) {
      if (!valid(row[field])) stats.missing[key]++;
    }

    const name = clean(row["NombreProducto"]);

    if (!valid(name)) {
      stats.invalidMedicineNames++;
      continue;
    }

    const exactKey = [
      row["Año"],
      row["Mes"],
      row["Solicitud"],
      row["Registro Sanitario"],
      row["NombreProducto"],
      row["Nombre Generico"],
      row["Principio Activo"],
      row["Fabricante"],
      row["Distribuidora"],
      row["Representante"],
      row["Empaque"],
      row["Forma Farmaceutica"],
      row["Especificacion_envase_primario"],
      row["Fecha Expiracion"],
      row["Estatus"],
      row["Tipo de producto"]
    ].map(clean).join("\u001f");

    if (stats.exactRows.has(exactKey)) {
      stats.duplicateRows++;
    } else {
      stats.exactRows.add(exactKey);
    }

    if (status.toUpperCase() === "VIGENTE") {
      stats.currentMedicines++;

      const identity = [
        name,
        row["Fabricante"],
        row["Forma Farmaceutica"],
        row["Empaque"],
        row["Especificacion_envase_primario"]
      ].map(normalize).join("|");

      stats.currentUnique.add(identity);
    }
  }

  console.log("\n========== ANÁLISIS DEL CATÁLOGO DIGEMAPS ==========\n");
  console.log("Archivo:", file);
  console.log("Total de registros:", stats.total);

  console.log("\n--- REGISTROS POR TIPO ---");
  console.table(stats.types);

  console.log("\n--- ESTATUS GENERAL ---");
  console.table(stats.statuses);

  console.log("\n--- MEDICAMENTOS ---");
  console.log("Total:", stats.medicines);
  console.table(stats.medicineStatuses);

  console.log("\n--- MEDICAMENTOS VIGENTES ---");
  console.log("Registros vigentes:", stats.currentMedicines);
  console.log("Identidades comerciales preliminares únicas:", stats.currentUnique.size);

  console.log("\n--- CAMPOS FALTANTES EN MEDICAMENTOS ---");
  console.table(stats.missing);

  console.log("\n--- CONTROL DE DUPLICADOS EXACTOS ---");
  console.log("Filas repetidas exactamente:", stats.duplicateRows);

  console.log("\n--- CONTROL DE NOMBRES ---");
  console.log("Medicamentos sin nombre válido:", stats.invalidMedicineNames);

  console.log("\n====================================================");
  console.log("ANÁLISIS TERMINADO. NO SE MODIFICÓ LA BASE DE DATOS.");
}

main().catch(error => {
  console.error("Error analizando CSV:", error);
  process.exit(1);
});
