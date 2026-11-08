const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Transform } = require("node:stream");
const { TextDecoder } = require("node:util");
const { parse } = require("csv-parse");
const { Pool } = require("pg");
const { loadEnvConfig } = require("@next/env");

loadEnvConfig(process.cwd());

const FILE = path.resolve(
  "database/imports/Registro-Sanitario-Medicamentos-Productos-Farmaceuticos-MISPAS-2018-2026.csv"
);

const SOURCE_CODE = "DIGEMAPS_REGISTRY";
const APPLY = process.argv.includes("--apply");

const batchArgument = process.argv.find(arg =>
  arg.startsWith("--batch-size=")
);

const BATCH_SIZE = batchArgument
  ? Number(batchArgument.split("=")[1])
  : 500;

const FIELDS = [
  "Año",
  "Mes",
  "Solicitud",
  "Registro Sanitario",
  "NombreProducto",
  "Nombre Generico",
  "Principio Activo",
  "Fabricante",
  "Distribuidora",
  "Representante",
  "Empaque",
  "Forma Farmaceutica",
  "Especificacion_envase_primario",
  "Fecha Expiracion",
  "Estatus",
  "Tipo de producto"
];

const INSERT_COLUMNS = [
  "source_id",
  "source_batch_id",
  "source_record_hash",
  "registration_request",
  "sanitary_registration",
  "product_name",
  "generic_name",
  "active_ingredient_text",
  "manufacturer_name",
  "distributor_name",
  "representative_name",
  "package_description",
  "dosage_form",
  "primary_container_specification",
  "expiration_date",
  "registration_status",
  "product_type",
  "application_year",
  "application_month",
  "source_data"
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 2,
  connectionTimeoutMillis: 10000,
  application_name: "farmacia-vitalis-digemaps-importer"
});

function clean(value) {
  return String(value ?? "").trim();
}

function valid(value) {
  return !["", "N/D", "ND", "NO DISPONIBLE"].includes(
    clean(value).toUpperCase()
  );
}

function parseDate(value) {
  const text = clean(value);

  if (!valid(text)) return null;

  const separator = text.includes("/") ? "/" : "-";
  const parts = text.split(separator);

  if (parts.length !== 3) return null;

  if (!parts.every(part =>
    part.length > 0 &&
    Array.from(part).every(char => char >= "0" && char <= "9")
  )) return null;

  let day;
  let month;
  let year;

  if (parts[0].length === 4) {
    year = Number(parts[0]);
    month = Number(parts[1]);
    day = Number(parts[2]);
  } else {
    day = Number(parts[0]);
    month = Number(parts[1]);

    year = parts[2].length === 2
      ? 2000 + Number(parts[2])
      : Number(parts[2]);
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
function parseYear(value) {
  const text = clean(value);

  if (!/^\d{4}$/.test(text)) return null;

  const year = Number(text);

  return year >= 1900 && year <= 2100 ? year : null;
}

function recordHash(row) {
  const canonical = FIELDS.map(field => clean(row[field]));
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

function makeRecord(row, sourceId, batchId) {
  const data = {};

  for (const field of FIELDS) {
    data[field] = clean(row[field]);
  }

  return [
    sourceId,
    batchId,
    recordHash(row),
    valid(row["Solicitud"]) ? clean(row["Solicitud"]) : null,
    valid(row["Registro Sanitario"]) ? clean(row["Registro Sanitario"]) : null,
    valid(row["NombreProducto"]) ? clean(row["NombreProducto"]) : null,
    valid(row["Nombre Generico"]) ? clean(row["Nombre Generico"]) : null,
    valid(row["Principio Activo"]) ? clean(row["Principio Activo"]) : null,
    valid(row["Fabricante"]) ? clean(row["Fabricante"]) : null,
    valid(row["Distribuidora"]) ? clean(row["Distribuidora"]) : null,
    valid(row["Representante"]) ? clean(row["Representante"]) : null,
    valid(row["Empaque"]) ? clean(row["Empaque"]) : null,
    valid(row["Forma Farmaceutica"]) ? clean(row["Forma Farmaceutica"]) : null,
    valid(row["Especificacion_envase_primario"])
      ? clean(row["Especificacion_envase_primario"])
      : null,
    parseDate(row["Fecha Expiracion"]),
    valid(row["Estatus"]) ? clean(row["Estatus"]) : null,
    valid(row["Tipo de producto"]) ? clean(row["Tipo de producto"]) : null,
    parseYear(row["Año"]),
    valid(row["Mes"]) ? clean(row["Mes"]) : null,
    JSON.stringify(data)
  ];
}

function createParser() {
  const decoder = new TextDecoder("windows-1252");

  const decodeStream = new Transform({
    transform(chunk, encoding, callback) {
      try {
        callback(null, decoder.decode(chunk, { stream: true }));
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        callback(null, decoder.decode());
      } catch (error) {
        callback(error);
      }
    }
  });

  return fs.createReadStream(FILE)
    .pipe(decodeStream)
    .pipe(parse({
      delimiter: ";",
      bom: true,
      columns: headers => {
        const result = headers.map(clean);

        while (result.length && !result[result.length - 1]) {
          result.pop();
        }

        return result;
      },
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true
    }));
}

function buildInsert(records) {
  const values = [];
  const groups = [];

  for (let index = 0; index < records.length; index++) {
    const placeholders = [];

    for (let column = 0; column < INSERT_COLUMNS.length; column++) {
      const position = index * INSERT_COLUMNS.length + column + 1;

      placeholders.push(
        column === INSERT_COLUMNS.length - 1
          ? `$${position}::jsonb`
          : `$${position}`
      );

      values.push(records[index][column]);
    }

    groups.push(`(${placeholders.join(", ")})`);
  }

  const sql = `
    INSERT INTO farmacia.catalog_product_registrations
      (${INSERT_COLUMNS.join(", ")})
    VALUES ${groups.join(", ")}
    ON CONFLICT (source_id, source_record_hash) DO NOTHING
    RETURNING id
  `;

  return { sql, values };
}

async function flushBatch(client, records, batchId) {
  if (!records.length) return 0;

  const { sql, values } = buildInsert(records);

  await client.query("BEGIN");

  try {
    const result = await client.query(sql, values);

    await client.query(
      `UPDATE farmacia.catalog_import_batches
       SET records_received = records_received + $2,
           records_created = records_created + $3
       WHERE id = $1`,
      [batchId, records.length, result.rowCount]
    );

    await client.query("COMMIT");

    return result.rowCount;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  if (!fs.existsSync(FILE)) {
    throw new Error(`No se encuentra el CSV: ${FILE}`);
  }

  if (
    !Number.isInteger(BATCH_SIZE) ||
    BATCH_SIZE < 50 ||
    BATCH_SIZE > 2000
  ) {
    throw new Error("El tamaño del lote debe estar entre 50 y 2000.");
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("No se encontró DATABASE_URL. Revisa .env.local.");
  }

  const client = await pool.connect();

  let batchId = null;
  let completed = false;

  const stats = {
    totalRows: 0,
    medicineRows: 0,
    uniqueHashes: new Set(),
    duplicateHashes: 0,
    invalidNames: 0,
    invalidDates: 0,
    created: 0
  };

  let pending = [];

  try {
    const sourceResult = await client.query(
      `SELECT id
       FROM farmacia.catalog_sources
       WHERE code = $1 AND is_active = TRUE`,
      [SOURCE_CODE]
    );

    if (!sourceResult.rowCount) {
      throw new Error(`No existe una fuente activa con código ${SOURCE_CODE}.`);
    }

    const sourceId = sourceResult.rows[0].id;

    const existingResult = await client.query(
      `SELECT COUNT(*)::bigint AS total
       FROM farmacia.catalog_product_registrations
       WHERE source_id = $1`,
      [sourceId]
    );

    console.log("\n========== IMPORTADOR DIGEMAPS ==========\n");
    console.log("Archivo:", FILE);
    console.log("Modo:", APPLY ? "IMPORTACIÓN REAL" : "PRUEBA SIN ESCRITURA");
    console.log("Tamaño de lote:", BATCH_SIZE);
    console.log("Registros históricos ya guardados:", existingResult.rows[0].total);

    if (APPLY) {
      const batchResult = await client.query(
        `INSERT INTO farmacia.catalog_import_batches
          (source_id, file_name, started_at, records_received,
           records_created, records_updated, records_rejected, status)
         VALUES ($1, $2, NOW(), 0, 0, 0, 0, 'processing')
         RETURNING id`,
        [sourceId, path.basename(FILE)]
      );

      batchId = batchResult.rows[0].id;

      console.log("Lote creado:", batchId);
    }

    const parser = createParser();

    for await (const row of parser) {
      stats.totalRows++;

      const type = clean(row["Tipo de producto"]).toUpperCase();

      if (type !== "MEDICAMENTOS") continue;

      stats.medicineRows++;

      const name = clean(row["NombreProducto"]);

      if (!valid(name)) {
        stats.invalidNames++;
      }

      const hash = recordHash(row);

      if (stats.uniqueHashes.has(hash)) {
        stats.duplicateHashes++;
      } else {
        stats.uniqueHashes.add(hash);
      }

      if (!parseDate(row["Fecha Expiracion"]) && valid(row["Fecha Expiracion"])) {
        stats.invalidDates++;
      }

      if (APPLY) {
        pending.push(makeRecord(row, sourceId, batchId));

        if (pending.length >= BATCH_SIZE) {
          const received = pending.length;
          const created = await flushBatch(client, pending, batchId);

          stats.created += created;
          pending = [];

          console.log(
            `Procesados: ${stats.medicineRows.toLocaleString("es-DO")} | ` +
            `Insertados: ${stats.created.toLocaleString("es-DO")} | ` +
            `En lote: ${received}`
          );
        }
      }
    }

    if (APPLY && pending.length) {
      stats.created += await flushBatch(client, pending, batchId);
      pending = [];
    }

    if (APPLY) {
      await client.query(
        `UPDATE farmacia.catalog_import_batches
         SET status = 'completed',
             completed_at = NOW(),
             records_updated = 0,
             records_rejected = 0
         WHERE id = $1`,
        [batchId]
      );
    }

    completed = true;

    console.log("\n========== RESULTADO ==========\n");
    console.log("Filas leídas:", stats.totalRows);
    console.log("Registros de medicamentos:", stats.medicineRows);
    console.log("Hashes únicos:", stats.uniqueHashes.size);
    console.log("Hashes repetidos dentro del archivo:", stats.duplicateHashes);
    console.log("Nombres faltantes:", stats.invalidNames);
    console.log("Fechas de expiración no interpretables:", stats.invalidDates);

    if (APPLY) {
      console.log("Registros insertados:", stats.created);
      console.log("Lote:", batchId);
    } else {
      console.log("Registros que se intentarían importar:", stats.medicineRows);
      console.log("No se insertó ni modificó ningún dato.");
      console.log("\nPara ejecutar la importación real:");
      console.log("node scripts/catalog-import-digemaps.cjs --apply");
    }

    console.log("\nProceso terminado.");
  } catch (error) {
    if (batchId && !completed) {
      try {
        await client.query(
          `UPDATE farmacia.catalog_import_batches
           SET status = 'failed',
               completed_at = NOW(),
               error_details = $2::jsonb
           WHERE id = $1`,
          [
            batchId,
            JSON.stringify({
              message: error.message,
              timestamp: new Date().toISOString()
            })
          ]
        );
      } catch (updateError) {
        console.error("No se pudo actualizar el lote fallido:", updateError.message);
      }
    }

    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error("\nERROR EN EL IMPORTADOR:");
  console.error(error.message);
  process.exitCode = 1;
});
