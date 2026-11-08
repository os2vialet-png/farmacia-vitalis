import "server-only";

import { db } from "@/src/lib/db";
import { centsToDecimal, toCents } from "@/src/lib/pos-math";

/**
 * Motor de respuestas de los asistentes (web y WhatsApp).
 *
 * Reglas fijas, aplicadas aquí y no en la interfaz:
 * - Solo responde con productos activos y verificados, con datos del catálogo y del inventario.
 * - Nunca revela cantidades de inventario: solo si hay disponibilidad (sí/no) y en qué sucursales.
 * - Nunca diagnostica, no recomienda medicamentos y deriva toda consulta clínica a un farmacéutico.
 * - Si no hay información confiable, lo dice; no inventa precios, disponibilidad ni características.
 * - No guarda el contenido de las conversaciones.
 */

export const MAX_MESSAGE_LENGTH = 300;

const EMERGENCY = /(emergencia|urgencia|desmay|convulsi|sangrado|no respira|ahogo|infarto|derrame|envenen|sobredosis)/i;

const CLINICAL = new RegExp(
  [
    "diagn",
    "s[ií]ntom",
    "me duele",
    "dolor",
    "fiebre",
    "\\btos\\b",
    "embaraz",
    "lactancia",
    "dosis",
    "cu[aá]nt[oa]s? (pastillas|tabletas|capsulas|c[aá]psulas|gotas|mg|miligramos|tomar)",
    "cu[aá]nto (debo|puedo|tomar)",
    "tratamiento",
    "\\brecet",
    "prescri",
    "me recomiendas?",
    "recomienda(me|n)?\\b",
    "qu[eé] (me )?(tomo|tomar|medicina|medicamento|sirve)",
    "infecci",
    "alergi",
    "es seguro",
    "puedo tomar",
    "interacci",
    "efectos? secundario",
    "para qu[eé] sirve",
    "contraindic",
    "\\bni[nñ]o",
    "beb[eé]",
  ].join("|"),
  "i",
);

const GREETING = /^\s*(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|hey|hi|ayuda|menu|men[uú])\b/i;

const STOPWORDS = new Set([
  "hay", "tienen", "tiene", "tienes", "disponible", "disponibles", "existencia", "existencias", "stock",
  "precio", "precios", "cuesta", "cuanto", "cuánto", "vale", "costo", "valor", "quiero", "necesito",
  "busco", "para", "por", "favor", "pueden", "puedo", "una", "uno", "unos", "unas", "les", "del",
  "que", "qué", "como", "cómo", "donde", "dónde", "tienen?", "la", "el", "los", "las", "con", "sin",
  "caja", "cajas", "tableta", "tabletas", "capsula", "capsulas", "cápsula", "cápsulas", "frasco", "frascos",
  "blister", "blísteres", "unidad", "unidades", "presentacion", "presentación", "sucursal", "farmacia",
  // Saludos y cortesía: no son nombres de producto.
  "hola", "buenas", "buenos", "dias", "tardes", "noches", "hey", "ayuda", "menu", "gracias", "saludos",
]);

export type AssistantProduct = {
  name: string;
  presentation: string | null;
  saleUnit: string;
  price: string | null;
  available: boolean;
  availableBranches: string[];
  requiresPrescription: boolean;
};

export type AssistantAnswer = {
  intent: "greeting" | "emergency" | "clinical" | "product" | "not_found" | "ask_product";
  reply: string;
  products: AssistantProduct[];
};

export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s./-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function referralText(): Promise<string> {
  const result = await db.query<{ value: string }>(
    `SELECT value FROM farmacia.app_settings WHERE key = 'clinical_referral_text'`,
  );
  return result.rows[0]?.value ?? "Para consultas clínicas, consulta con un farmacéutico en la sucursal.";
}

/** Términos útiles de la consulta, sin palabras de relleno. */
export function extractTerms(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized
    .split(" ")
    .map((token) => token.replace(/[?¿!¡.,]/g, ""))
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

type Row = {
  id: string;
  product_name: string;
  brand_name: string | null;
  presentation: string | null;
  sale_unit: string;
  is_prescription: boolean | null;
  branch_name: string;
  sale_price: string | null;
  available: boolean;
};

/** Busca productos verificados y activos por todos los términos (todos deben aparecer). */
async function searchProducts(terms: string[]): Promise<AssistantProduct[]> {
  if (terms.length === 0) return [];

  const conditions = terms.map((_, index) => `(
    p.normalized_name ILIKE '%' || $${index + 1} || '%'
    OR lower(COALESCE(p.brand_name, '')) ILIKE '%' || $${index + 1} || '%'
  )`);

  const candidates = await db.query<{ id: string }>(
    `SELECT p.id
     FROM farmacia.catalog_products p
     WHERE p.is_active = TRUE
       AND p.verification_status = 'verified'
       AND p.sale_unit IS NOT NULL AND btrim(p.sale_unit) <> ''
       AND ${conditions.join(" AND ")}
     ORDER BY p.product_name
     LIMIT 6`,
    terms,
  );

  if (candidates.rows.length === 0) return [];

  const ids = candidates.rows.map((row) => row.id);

  const rows = await db.query<Row>(
    `WITH lots AS (
       SELECT l.branch_id, l.product_id, SUM(l.quantity_remaining) AS remaining
       FROM farmacia.inventory_lots l
       WHERE l.product_id = ANY($1::uuid[])
         AND l.status = 'available'
         AND l.quantity_remaining > 0
         AND l.expiration_date IS NOT NULL
         AND l.expiration_date >= CURRENT_DATE
       GROUP BY l.branch_id, l.product_id
     )
     SELECT p.id, p.product_name, p.brand_name, p.presentation, p.sale_unit, p.is_prescription,
            b.name AS branch_name,
            price.sale_price,
            (
              price.sale_price IS NOT NULL
              AND GREATEST(0, LEAST(
                COALESCE(s.quantity_on_hand, 0) - COALESCE(s.quantity_reserved, 0),
                COALESCE(lots.remaining, 0)
              )) > 0
            ) AS available
     FROM farmacia.catalog_products p
     CROSS JOIN farmacia.branches b
     LEFT JOIN LATERAL (
       SELECT pbp.sale_price FROM farmacia.product_branch_prices pbp
       WHERE pbp.product_id = p.id AND pbp.branch_id = b.id
         AND pbp.effective_from <= NOW()
         AND (pbp.effective_until IS NULL OR pbp.effective_until > NOW())
       ORDER BY pbp.effective_from DESC LIMIT 1
     ) price ON TRUE
     LEFT JOIN farmacia.inventory_stock s ON s.branch_id = b.id AND s.product_id = p.id
     LEFT JOIN lots ON lots.branch_id = b.id AND lots.product_id = p.id
     WHERE p.id = ANY($1::uuid[]) AND b.is_active = TRUE
     ORDER BY p.product_name, b.name`,
    [ids],
  );

  type Accumulator = {
    name: string;
    presentation: string | null;
    saleUnit: string;
    requiresPrescription: boolean;
    priceCents: number[];
    availableBranches: string[];
  };

  const byProduct = new Map<string, Accumulator>();

  for (const row of rows.rows) {
    let entry = byProduct.get(row.id);

    if (!entry) {
      entry = {
        name: row.product_name,
        presentation: row.presentation,
        saleUnit: row.sale_unit,
        requiresPrescription: row.is_prescription === true,
        priceCents: [],
        availableBranches: [],
      };
      byProduct.set(row.id, entry);
    }

    if (row.sale_price !== null) {
      entry.priceCents.push(toCents(row.sale_price));
    }

    if (row.available) {
      entry.availableBranches.push(row.branch_name);
    }
  }

  return Array.from(byProduct.values()).map((entry) => {
    const min = entry.priceCents.length > 0 ? Math.min(...entry.priceCents) : null;
    const max = entry.priceCents.length > 0 ? Math.max(...entry.priceCents) : null;

    let price: string | null = null;
    if (min !== null && max !== null) {
      price = min === max ? `RD$ ${centsToDecimal(min)}` : `desde RD$ ${centsToDecimal(min)}`;
    }

    return {
      name: entry.name,
      presentation: entry.presentation,
      saleUnit: entry.saleUnit,
      price,
      available: entry.availableBranches.length > 0,
      availableBranches: entry.availableBranches,
      requiresPrescription: entry.requiresPrescription,
    };
  });
}

function describeProduct(product: AssistantProduct): string {
  const parts: string[] = [];
  const presentation = product.presentation ? ` (${product.presentation})` : "";

  if (product.available) {
    const where = product.availableBranches.length > 0 ? ` en ${product.availableBranches.join(", ")}` : "";
    parts.push(`Sí, tenemos disponible ${product.name}${presentation}${where}.`);
  } else {
    parts.push(`En este momento no tenemos disponible ${product.name}${presentation}.`);
  }

  parts.push(`Unidad de venta: ${product.saleUnit}.`);

  if (product.price) {
    parts.push(`Precio: ${product.price}.`);
  } else {
    parts.push("El precio no está disponible en línea; consulta en la sucursal.");
  }

  if (product.requiresPrescription) {
    parts.push("Requiere receta médica: un farmacéutico debe orientarte.");
  }

  return parts.join(" ");
}

/** Respuesta a un mensaje de cliente. Pura respecto de la entrada, lee solo el catálogo. */
export async function answer(rawMessage: string): Promise<AssistantAnswer> {
  const message = rawMessage.trim().slice(0, MAX_MESSAGE_LENGTH);

  if (message.length === 0) {
    return {
      intent: "greeting",
      reply: "Hola, soy el asistente de Farmacia Vitalis. Escribe el nombre de un producto para consultar disponibilidad y precio.",
      products: [],
    };
  }

  if (EMERGENCY.test(message)) {
    return {
      intent: "emergency",
      reply: "Si es una emergencia, llama al 911 o acude al centro de salud más cercano. No podemos atender emergencias por este medio.",
      products: [],
    };
  }

  if (CLINICAL.test(message)) {
    return { intent: "clinical", reply: await referralText(), products: [] };
  }

  if (GREETING.test(message) && extractTerms(message).length === 0) {
    return {
      intent: "greeting",
      reply: "Hola. Puedo informarte si un producto está disponible, su presentación, unidad de venta y precio. ¿Qué producto buscas?",
      products: [],
    };
  }

  const terms = extractTerms(message);

  if (terms.length === 0) {
    return {
      intent: "ask_product",
      reply: "¿Qué producto buscas? Escribe su nombre o marca.",
      products: [],
    };
  }

  const products = await searchProducts(terms);

  if (products.length === 0) {
    return {
      intent: "not_found",
      reply: "No encontré ese producto en nuestro catálogo verificado. Puedes consultar con un farmacéutico en la sucursal.",
      products: [],
    };
  }

  if (products.length === 1) {
    return { intent: "product", reply: describeProduct(products[0]), products };
  }

  const names = products.slice(0, 5).map((product) => product.name).join("; ");
  return {
    intent: "product",
    reply: `Encontré ${products.length > 5 ? "varias" : products.length} opciones: ${names}. ¿Cuál necesitas?`,
    products: products.slice(0, 5),
  };
}

/**
 * Límite de uso de los asistentes, persistido en la base de datos.
 * Sobrevive reinicios del servidor y cuenta igual con varias instancias
 * (ventana fija por clave: IP del web y remitente de WhatsApp).
 * Si la base no responde se deniega: sin base de datos no hay control de abuso.
 */
export async function allowRequest(key: string, limit = 20, windowMs = 60_000): Promise<boolean> {
  const windowSeconds = Math.max(1, Math.ceil(windowMs / 1000));

  try {
    const result = await db.query<{ allowed: boolean }>(
      `INSERT INTO farmacia.assistant_rate_limits (key, window_start, window_seconds, hit_count)
       VALUES ($1, now(), $2::int, 1)
       ON CONFLICT (key) DO UPDATE SET
         window_start = CASE
           WHEN farmacia.assistant_rate_limits.window_start
                + interval '1 second' * farmacia.assistant_rate_limits.window_seconds <= now() THEN now()
           ELSE farmacia.assistant_rate_limits.window_start
         END,
         hit_count = CASE
           WHEN farmacia.assistant_rate_limits.window_start
                + interval '1 second' * farmacia.assistant_rate_limits.window_seconds <= now() THEN 1
           ELSE farmacia.assistant_rate_limits.hit_count + 1
         END,
         window_seconds = EXCLUDED.window_seconds
       RETURNING hit_count <= $3::int AS allowed`,
      [key, windowSeconds, limit],
    );

    // Limpieza ocasional de ventanas cerradas para que la tabla no crezca sin fin.
    if (Math.random() < 0.05) {
      await db.query(`DELETE FROM farmacia.assistant_rate_limits WHERE window_start < now() - interval '2 days'`).catch(
        () => undefined,
      );
    }

    return result.rows[0]?.allowed === true;
  } catch (error) {
    console.error("Error del limitador de asistentes:", error);
    return false;
  }
}
