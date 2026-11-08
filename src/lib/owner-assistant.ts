import "server-only";

import { randomBytes } from "node:crypto";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { accessibleBranchIds, canOperateBranch } from "@/src/lib/access";
import { hasPermission, isOwner, type AuthSession } from "@/src/lib/auth/permissions";
import { hashPassword } from "@/src/lib/auth/password";
import { writeAudit } from "@/src/lib/audit";
import { BusinessError } from "@/src/lib/errors";
import { createCatalogProduct, normalizeProductName } from "@/src/lib/catalog-create";
import { centsToDecimal, toCents } from "@/src/lib/pos-math";

/**
 * Asistente del dueño. Interpreta órdenes en español con reglas (sin servicios externos),
 * propone una acción concreta y SOLO la ejecuta cuando el usuario la confirma.
 * Al ejecutar, vuelve a validar los datos y los permisos; cada acción queda auditada.
 */

export type ProposalAction =
  | "create_employee"
  | "deactivate_employee"
  | "create_product"
  | "set_price"
  | "update_setting";

export type Proposal = { action: ProposalAction; params: Record<string, unknown>; summary: string[] };

export type AssistantReply = {
  reply: string;
  proposal?: Proposal;
  bullets?: string[];
};

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrador",
  pharmacist: "Farmacéutico",
  inventory_manager: "Encargado de inventario",
  seller: "Vendedor",
};

const SETTING_LABELS: Record<string, string> = {
  pharmacy_name: "Nombre de la farmacia",
  receipt_footer: "Pie del comprobante",
  clinical_referral_text: "Texto de derivación clínica",
};

/** Minúsculas y sin acentos, para comparar. */
function plain(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function lower(text: string): string {
  return plain(text).toLowerCase().replace(/\s+/g, " ").trim();
}

const HELP = [
  "«avisos» — resumen: stock bajo, vencimientos, transferencias, productos sin verificar o sin precio, ventas de hoy.",
  "«crea un vendedor llamado Ana Gómez en Villa Mella» (roles: vendedor, farmacéutico, encargado de inventario, administrador; opcional «usuario agomez»).",
  "«desactiva al usuario agomez»",
  "«agrega el medicamento Amoxil forma cápsula concentración 500 mg presentación caja x 21 unidad caja marca GSK»",
  "«pon el precio de amoxil 500 a 150 en Villa Mella»",
  "«cambia el pie del comprobante a Gracias por preferirnos» (también: nombre de la farmacia, derivación clínica)",
];

type Branch = { id: string; name: string; code: string };

async function branchesFor(session: AuthSession): Promise<Branch[]> {
  const result = await db.query<Branch>(
    `SELECT id, name, code FROM farmacia.branches WHERE is_active = TRUE ORDER BY name`,
  );
  if (isOwner(session)) return result.rows;
  const ids = new Set(await accessibleBranchIds(session, "branches.view"));
  return result.rows.filter((branch) => ids.has(branch.id));
}

/** Resuelve una sucursal por nombre o código, sin ambigüedad. */
function matchBranch(branches: Branch[], term: string | null): Branch | null | "ambiguous" {
  if (!term) return branches.length === 1 ? branches[0] : null;
  const wanted = lower(term).replace(/^(la |el )?(sucursal )?/, "");
  const found = branches.filter(
    (branch) => lower(branch.name).includes(wanted) || lower(branch.code) === wanted,
  );
  if (found.length === 1) return found[0];
  return found.length > 1 ? "ambiguous" : null;
}

function roleFrom(text: string): string | null {
  if (/farmaceut/.test(text)) return "pharmacist";
  if (/administrador/.test(text)) return "admin";
  if (/encargad|inventario/.test(text)) return "inventory_manager";
  if (/vendedor|cajer/.test(text)) return "seller";
  return null;
}

function suggestUsername(firstName: string, lastName: string): string {
  return lower(`${firstName[0] ?? ""}${lastName.split(" ")[0] ?? ""}`).replace(/[^a-z0-9]/g, "").slice(0, 30);
}

const PRODUCT_KEYWORDS = ["forma", "concentracion", "presentacion", "marca", "unidad", "registro", "impuesto", "receta"];

/** Divide «nombre forma X concentracion Y …» en campos por palabra clave. */
function productFields(text: string): Record<string, string> {
  const source = plain(text);
  const low = source.toLowerCase();
  const marks: { key: string; start: number; valueStart: number }[] = [];

  for (const key of PRODUCT_KEYWORDS) {
    const match = new RegExp(`\\b${key}\\b(\\s+de)?`, "i").exec(low);
    if (match) marks.push({ key, start: match.index, valueStart: match.index + match[0].length });
  }
  marks.sort((a, b) => a.start - b.start);

  const fields: Record<string, string> = {};
  const nameMatch = /\b(medicamento|producto)\b/i.exec(low);
  if (nameMatch) {
    const from = nameMatch.index + nameMatch[0].length;
    const to = marks.find((mark) => mark.start > from)?.start ?? source.length;
    fields.name = source.slice(from, to).trim().replace(/^(nuevo|llamado|de nombre)\s+/i, "");
  }
  marks.forEach((mark, index) => {
    const end = marks[index + 1]?.start ?? source.length;
    fields[mark.key] = source.slice(mark.valueStart, end).trim();
  });
  return fields;
}

/** Interpreta un mensaje y devuelve una respuesta o una propuesta a confirmar. */
export async function interpret(session: AuthSession, message: string): Promise<AssistantReply> {
  const text = lower(message);

  if (!text || /^(ayuda|help|hola|que puedes|comandos|menu)/.test(text)) {
    return { reply: "Puedo ayudarte con estas tareas. Siempre te pido confirmación antes de cambiar algo:", bullets: HELP };
  }

  if (/\b(aviso|avisos|alerta|alertas|resumen|pendientes|como va|como esta|que hay)\b/.test(text)) {
    return alertsSummary(session);
  }

  // Desactivar empleado.
  const deactivate = /\b(desactiva|desactivar|da de baja|dar de baja|bloquea|bloquear)\b\s+(?:a\s+|al\s+)?(?:empleado\s+|usuario\s+|usuaria\s+)?([a-z0-9._-]{3,40})/.exec(text);
  if (deactivate) {
    const username = deactivate[2];
    const user = await db.query<{ id: string; first_name: string; last_name: string; is_active: boolean }>(
      `SELECT id, first_name, last_name, is_active FROM farmacia.users WHERE LOWER(username) = $1`,
      [username],
    );
    if (user.rows.length === 0) return { reply: `No encontré un usuario «${username}». Usa el nombre de usuario exacto.` };
    const target = user.rows[0];
    if (!target.is_active) return { reply: `${target.first_name} ${target.last_name} ya está desactivado.` };
    return {
      reply: "Esto es lo que haré:",
      proposal: {
        action: "deactivate_employee",
        params: { userId: target.id },
        summary: [`Desactivar a ${target.first_name} ${target.last_name} (${username}).`, "Sus sesiones abiertas se cerrarán de inmediato."],
      },
    };
  }

  // Crear empleado.
  if (/\b(crea|crear|agrega|agregar|registra|registrar|nuevo|nueva|anade|añade)\b.*\b(empleado|empleada|usuario|usuaria|vendedor|vendedora|cajero|cajera|farmaceutic\w*|administrador\w*|encargad\w*)\b/.test(text)) {
    const role = roleFrom(text);
    const source = plain(message);
    const nameMatch = /(?:llamad[oa]|nombre|de nombre)\s+([A-Za-zÑñ]+(?:\s+[A-Za-zÑñ]+){1,3}?)(?=\s+(?:usuario|rol|como|en|para|sucursal)\b|\s*$)/i.exec(source);
    const usernameMatch = /\busuario\s+([A-Za-z0-9._-]{3,40})/i.exec(source);
    const branchMatch = /\b(?:en|sucursal)\s+(?:la\s+)?(?:sucursal\s+)?([A-Za-z0-9 -]+?)(?=\s+(?:usuario|rol|como)\b|\s*$)/i.exec(source.replace(/(?:llamad[oa]|nombre)\s+[A-Za-zÑñ ]+?(?=\s+en\b)/i, ""));

    const missing: string[] = [];
    if (!role) missing.push("el rol (vendedor, farmacéutico, encargado de inventario o administrador)");
    if (!nameMatch) missing.push("el nombre y apellido («llamado Ana Gómez»)");

    const branches = await branchesFor(session);
    const branch = matchBranch(branches, branchMatch?.[1] ?? null);
    if (branch === "ambiguous") missing.push("una sucursal más específica");
    else if (!branch) missing.push(`la sucursal (${branches.map((item) => item.name).join(", ")})`);

    if (missing.length > 0 || !nameMatch || !role || !branch || branch === "ambiguous") {
      return { reply: `Para crear el empleado me falta: ${missing.join("; ")}. Ejemplo: «crea un vendedor llamado Ana Gómez en Villa Mella».` };
    }

    const parts = nameMatch[1].trim().split(/\s+/);
    const firstName = parts[0];
    const lastName = parts.slice(1).join(" ");
    const username = (usernameMatch?.[1] ?? suggestUsername(firstName, lastName)).toLowerCase();

    return {
      reply: "Esto es lo que haré:",
      proposal: {
        action: "create_employee",
        params: { firstName, lastName, username, roleCode: role, branchId: branch.id },
        summary: [
          `Crear a ${firstName} ${lastName} como ${ROLE_LABELS[role]} en ${branch.name}.`,
          `Usuario: ${username}. Se generará una contraseña temporal que deberá cambiar al entrar.`,
        ],
      },
    };
  }

  // Agregar medicamento.
  if (/\b(agrega|agregar|crea|crear|registra|registrar|nuevo|nueva|anade)\b.*\b(medicamento|producto)\b/.test(text)) {
    const fields = productFields(message);
    if (!fields.name || fields.name.length < 2) {
      return { reply: "Indica el nombre. Ejemplo: «agrega el medicamento Amoxil forma cápsula concentración 500 mg presentación caja x 21 unidad caja»." };
    }
    const taxValue = fields.impuesto ? Number(fields.impuesto.replace(/[^0-9.,]/g, "").replace(",", ".")) : null;
    const params = {
      productName: fields.name.toUpperCase(),
      dosageForm: fields.forma || undefined,
      strength: fields.concentracion || undefined,
      presentation: fields.presentacion || undefined,
      brandName: fields.marca || undefined,
      saleUnit: fields.unidad || undefined,
      sanitaryRegistration: fields.registro ? fields.registro.toUpperCase() : undefined,
      taxPercent: taxValue !== null && Number.isFinite(taxValue) ? taxValue : null,
      isPrescription: /\breceta\b/.test(text),
    };
    const detail = [
      params.dosageForm && `forma ${params.dosageForm}`,
      params.strength && `concentración ${params.strength}`,
      params.presentation && `presentación ${params.presentation}`,
      params.brandName && `marca ${params.brandName}`,
      params.saleUnit && `unidad ${params.saleUnit}`,
      params.sanitaryRegistration && `registro ${params.sanitaryRegistration}`,
    ].filter(Boolean).join(", ");
    return {
      reply: "Esto es lo que haré:",
      proposal: {
        action: "create_product",
        params,
        summary: [
          `Crear el producto ${params.productName}${detail ? ` (${detail})` : ""}.`,
          "Quedará activo para compras y pendiente de verificación: no se vende hasta que un farmacéutico lo verifique.",
        ],
      },
    };
  }

  // Fijar precio.
  const price = /precio\s+(?:de\s+|del\s+|para\s+)?(.+?)\s+(?:a|en|=)\s+(?:rd\$\s*|\$\s*)?(\d+(?:[.,]\d{1,2})?)(?:\s+(?:pesos\s+)?(?:en\s+)?(?:la\s+)?(?:sucursal\s+)?(.+))?$/.exec(text);
  if (price) {
    const term = normalizeProductName(price[1]);
    const amount = Number(price[2].replace(",", "."));
    const products = await db.query<{ id: string; product_name: string; normalized_name: string }>(
      `SELECT id, product_name, normalized_name FROM farmacia.catalog_products
       WHERE is_active = TRUE AND normalized_name LIKE '%' || $1 || '%'
       ORDER BY (normalized_name = $1) DESC, length(normalized_name)
       LIMIT 6`,
      [term],
    );
    const exact = products.rows.filter((row) => row.normalized_name === term);
    const chosen = exact.length === 1 ? exact[0] : products.rows.length === 1 ? products.rows[0] : null;
    if (!chosen) {
      return products.rows.length === 0
        ? { reply: `No encontré un producto activo que coincida con «${price[1]}».` }
        : { reply: "Encontré varios productos. Escribe el nombre exacto de uno:", bullets: products.rows.map((row) => row.product_name) };
    }
    const branches = await branchesFor(session);
    const branch = matchBranch(branches, price[3] ?? null);
    if (!branch || branch === "ambiguous") {
      return { reply: `¿En qué sucursal? Opciones: ${branches.map((item) => item.name).join(", ")}. Ejemplo: «pon el precio de ${chosen.product_name.toLowerCase()} a ${amount} en ${branches[0]?.name ?? "la sucursal"}».` };
    }
    return {
      reply: "Esto es lo que haré:",
      proposal: {
        action: "set_price",
        params: { productId: chosen.id, branchId: branch.id, salePrice: amount },
        summary: [`Fijar el precio de ${chosen.product_name} en RD$ ${centsToDecimal(toCents(amount))} (impuesto incluido) en ${branch.name}.`, "El precio anterior se cierra y queda en el historial."],
      },
    };
  }

  // Configuración.
  const setting = /(nombre de la farmacia|pie del? comprobante|derivaci[oó]n cl[ií]nica|texto de derivaci[oó]n)\s*(?:es|a|:|=|por)?\s+(.+)$/i.exec(message.trim());
  if (setting && /\b(cambia|cambiar|pon|poner|configura|configurar|establece|actualiza|actualizar)\b/.test(text)) {
    const phrase = lower(setting[1]);
    const key = phrase.startsWith("nombre") ? "pharmacy_name" : phrase.startsWith("pie") ? "receipt_footer" : "clinical_referral_text";
    const value = setting[2].trim().replace(/^["«]|["»]$/g, "");
    return {
      reply: "Esto es lo que haré:",
      proposal: { action: "update_setting", params: { key, value }, summary: [`Cambiar «${SETTING_LABELS[key]}» a: ${value}`] },
    };
  }

  return { reply: "No entendí la orden. Estas son las tareas que puedo hacer:", bullets: HELP };
}

/** Resumen de avisos del negocio en las sucursales que la sesión puede ver. */
async function alertsSummary(session: AuthSession): Promise<AssistantReply> {
  const branchIds = isOwner(session)
    ? (await branchesFor(session)).map((branch) => branch.id)
    : await accessibleBranchIds(session, "reports.view");

  if (branchIds.length === 0) return { reply: "Tu cuenta no tiene sucursales con acceso a reportes." };

  const result = await db.query<Record<string, string | number>>(
    `SELECT
       (SELECT COUNT(*) FROM farmacia.inventory_stock s
         WHERE s.branch_id = ANY($1::uuid[])
           AND (s.reorder_point IS NOT NULL OR s.minimum_stock IS NOT NULL)
           AND s.quantity_on_hand - s.quantity_reserved <= COALESCE(s.reorder_point, s.minimum_stock))::int AS low_stock,
       (SELECT COUNT(*) FROM farmacia.inventory_lots l
         WHERE l.branch_id = ANY($1::uuid[]) AND l.status = 'available' AND l.quantity_remaining > 0
           AND l.expiration_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30)::int AS expiring,
       (SELECT COUNT(*) FROM farmacia.inventory_lots l
         WHERE l.branch_id = ANY($1::uuid[]) AND l.quantity_remaining > 0
           AND l.expiration_date < CURRENT_DATE AND l.status <> 'depleted')::int AS expired,
       (SELECT COUNT(*) FROM farmacia.transfers t
         WHERE (t.origin_branch_id = ANY($1::uuid[]) OR t.destination_branch_id = ANY($1::uuid[]))
           AND t.status IN ('requested', 'approved', 'in_transit'))::int AS transfers_open,
       (SELECT COUNT(*) FROM farmacia.catalog_products
         WHERE is_active AND verification_status <> 'verified' AND duplicate_of_product_id IS NULL)::int AS unverified,
       (SELECT COUNT(*) FROM farmacia.catalog_products p
         WHERE p.is_active AND p.verification_status = 'verified'
           AND (p.sale_unit IS NULL OR NOT EXISTS (
             SELECT 1 FROM farmacia.product_branch_prices pbp
             WHERE pbp.product_id = p.id AND pbp.effective_until IS NULL)))::int AS verified_not_sellable,
       (SELECT COUNT(*) FROM farmacia.users WHERE is_active AND must_change_password)::int AS temp_passwords,
       (SELECT COUNT(*) FROM farmacia.sales s
         WHERE s.branch_id = ANY($1::uuid[]) AND s.status = 'completed'
           AND s.created_at >= (now() AT TIME ZONE 'America/Santo_Domingo')::date::timestamp AT TIME ZONE 'America/Santo_Domingo')::int AS sales_today,
       (SELECT COALESCE(SUM(s.total), 0) FROM farmacia.sales s
         WHERE s.branch_id = ANY($1::uuid[]) AND s.status = 'completed'
           AND s.created_at >= (now() AT TIME ZONE 'America/Santo_Domingo')::date::timestamp AT TIME ZONE 'America/Santo_Domingo')::text AS sales_today_total`,
    [branchIds],
  );

  const r = result.rows[0];
  const n = (key: string) => Number(r[key]);
  const bullets = [
    `Ventas de hoy: ${n("sales_today")} por RD$ ${Number(r.sales_today_total).toFixed(2)}.`,
    n("low_stock") > 0 ? `⚠ ${n("low_stock")} producto(s) en o bajo el punto de reposición.` : "Sin productos bajo el punto de reposición configurado.",
    n("expiring") > 0 ? `⚠ ${n("expiring")} lote(s) vencen en los próximos 30 días.` : "Ningún lote vence en los próximos 30 días.",
    n("expired") > 0 ? `⛔ ${n("expired")} lote(s) vencidos con existencia: retíralos del estante.` : "Sin lotes vencidos con existencia.",
    n("transfers_open") > 0 ? `${n("transfers_open")} transferencia(s) pendientes de aprobar, despachar o recibir.` : "Sin transferencias pendientes.",
    `${n("unverified").toLocaleString("es-DO")} producto(s) activos sin verificar (se pueden comprar, no vender).`,
    n("verified_not_sellable") > 0 ? `${n("verified_not_sellable")} producto(s) verificados sin unidad de venta o sin precio: aún no se pueden vender.` : "Todos los productos verificados tienen unidad y precio.",
    n("temp_passwords") > 0 ? `${n("temp_passwords")} empleado(s) aún con contraseña temporal.` : "Ningún empleado con contraseña temporal.",
  ];
  return { reply: "Resumen del negocio:", bullets };
}

const executeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("create_employee"),
    params: z.object({
      firstName: z.string().trim().min(1).max(80),
      lastName: z.string().trim().min(1).max(80),
      username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/),
      roleCode: z.enum(["admin", "pharmacist", "inventory_manager", "seller"]),
      branchId: z.string().uuid(),
    }),
  }),
  z.object({ action: z.literal("deactivate_employee"), params: z.object({ userId: z.string().uuid() }) }),
  z.object({ action: z.literal("create_product"), params: z.record(z.string(), z.unknown()) }),
  z.object({
    action: z.literal("set_price"),
    params: z.object({ productId: z.string().uuid(), branchId: z.string().uuid(), salePrice: z.number().positive().max(100000000) }),
  }),
  z.object({
    action: z.literal("update_setting"),
    params: z.object({ key: z.enum(["pharmacy_name", "receipt_footer", "clinical_referral_text"]), value: z.string().trim().min(1).max(500) }),
  }),
]);

/** Ejecuta una propuesta confirmada. Revalida datos y permisos. */
export async function execute(session: AuthSession, raw: unknown, ip: string | null): Promise<{ message: string; temporaryPassword?: string }> {
  const parsed = executeSchema.safeParse(raw);
  if (!parsed.success) throw new BusinessError("La acción no es válida. Vuelve a escribir la orden.", 400);
  const command = parsed.data;
  const actor = session.user.id;

  if (command.action === "create_employee" || command.action === "deactivate_employee") {
    if (!isOwner(session)) throw new BusinessError("Solo el propietario puede administrar empleados.", 403);
  }
  if (command.action === "create_product" && !hasPermission(session, "catalog.create")) {
    throw new BusinessError("No tienes permiso para crear productos.", 403);
  }
  if (command.action === "set_price" && !(await canOperateBranch(session, "catalog.prices", command.params.branchId))) {
    throw new BusinessError("No tienes permiso para fijar precios en esa sucursal.", 403);
  }
  if (command.action === "update_setting" && !hasPermission(session, "settings.manage")) {
    throw new BusinessError("Solo el propietario puede cambiar la configuración.", 403);
  }

  // El hash es costoso: se calcula fuera de la transacción.
  const temporaryPassword = command.action === "create_employee" ? `${randomBytes(18).toString("base64url")}7k` : undefined;
  const passwordHash = temporaryPassword ? await hashPassword(temporaryPassword) : undefined;

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    let message = "";

    switch (command.action) {
      case "create_employee": {
        const p = command.params;
        const exists = await client.query(`SELECT 1 FROM farmacia.users WHERE LOWER(username) = LOWER($1)`, [p.username]);
        if (exists.rows.length > 0) throw new BusinessError(`El usuario «${p.username}» ya existe. Indica otro con «usuario …».`, 409);
        const branch = await client.query(`SELECT id FROM farmacia.branches WHERE id = $1 AND is_active FOR SHARE`, [p.branchId]);
        if (branch.rows.length === 0) throw new BusinessError("La sucursal no existe o está inactiva.", 404);
        const user = await client.query<{ id: string }>(
          `INSERT INTO farmacia.users (username, password_hash, first_name, last_name, is_active, must_change_password)
           VALUES ($1, $2, $3, $4, TRUE, TRUE) RETURNING id`,
          [p.username, passwordHash, p.firstName, p.lastName],
        );
        await client.query(
          `INSERT INTO farmacia.user_roles (user_id, role_id, branch_id)
           SELECT $1, id, $2 FROM farmacia.roles WHERE code = $3`,
          [user.rows[0].id, p.branchId, p.roleCode],
        );
        await writeAudit(client, {
          actorUserId: actor, branchId: p.branchId, action: "create", entity: "user", entityId: user.rows[0].id,
          newValues: { username: p.username, role: p.roleCode, via: "asistente_dueno" }, ip,
        });
        message = `Empleado ${p.firstName} ${p.lastName} creado con el usuario ${p.username}. Entrega la contraseña temporal en persona.`;
        break;
      }
      case "deactivate_employee": {
        const target = await client.query<{ username: string; is_owner: boolean }>(
          `SELECT u.username, EXISTS (SELECT 1 FROM farmacia.user_roles ur JOIN farmacia.roles r ON r.id = ur.role_id
                                       WHERE ur.user_id = u.id AND r.code = 'owner') AS is_owner
           FROM farmacia.users u WHERE u.id = $1 FOR UPDATE OF u`,
          [command.params.userId],
        );
        if (target.rows.length === 0) throw new BusinessError("El usuario no existe.", 404);
        if (target.rows[0].is_owner || command.params.userId === actor) {
          throw new BusinessError("Las cuentas de propietario y tu propia cuenta no se desactivan desde aquí.", 403);
        }
        await client.query(`UPDATE farmacia.users SET is_active = FALSE, updated_at = NOW() WHERE id = $1`, [command.params.userId]);
        await client.query(`UPDATE farmacia.user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [command.params.userId]);
        await writeAudit(client, {
          actorUserId: actor, action: "user.deactivate", entity: "user", entityId: command.params.userId,
          newValues: { isActive: false, username: target.rows[0].username, via: "asistente_dueno" }, ip,
        });
        message = `Usuario ${target.rows[0].username} desactivado y sus sesiones cerradas.`;
        break;
      }
      case "create_product": {
        const product = await createCatalogProduct(client, command.params, actor, ip);
        message = `Producto ${product.productName} creado (pendiente de verificación).`;
        break;
      }
      case "set_price": {
        const p = command.params;
        const priceText = centsToDecimal(toCents(p.salePrice));
        const product = await client.query<{ product_name: string }>(
          `SELECT product_name FROM farmacia.catalog_products WHERE id = $1 FOR SHARE`, [p.productId]);
        if (product.rows.length === 0) throw new BusinessError("El producto no existe.", 404);
        const previous = await client.query<{ sale_price: string }>(
          `UPDATE farmacia.product_branch_prices SET effective_until = NOW(), updated_at = NOW()
           WHERE product_id = $1 AND branch_id = $2 AND effective_from <= NOW()
             AND (effective_until IS NULL OR effective_until > NOW())
           RETURNING sale_price`,
          [p.productId, p.branchId],
        );
        await client.query(
          `INSERT INTO farmacia.product_branch_prices (product_id, branch_id, sale_price, effective_from) VALUES ($1, $2, $3, NOW())`,
          [p.productId, p.branchId, priceText],
        );
        await writeAudit(client, {
          actorUserId: actor, branchId: p.branchId, action: "catalog.price_change", entity: "catalog_product", entityId: p.productId,
          oldValues: { salePrice: previous.rows[0]?.sale_price ?? null }, newValues: { salePrice: priceText, via: "asistente_dueno" }, ip,
        });
        message = `Precio de ${product.rows[0].product_name}: RD$ ${priceText}.`;
        break;
      }
      case "update_setting": {
        const p = command.params;
        const current = await client.query<{ value: string }>(`SELECT value FROM farmacia.app_settings WHERE key = $1 FOR UPDATE`, [p.key]);
        await client.query(`UPDATE farmacia.app_settings SET value = $2, updated_by = $3, updated_at = NOW() WHERE key = $1`, [p.key, p.value, actor]);
        await writeAudit(client, {
          actorUserId: actor, action: "settings.update", entity: "app_setting",
          oldValues: { key: p.key, value: current.rows[0]?.value ?? null }, newValues: { key: p.key, value: p.value, via: "asistente_dueno" }, ip,
        });
        message = `«${SETTING_LABELS[p.key]}» actualizado.`;
        break;
      }
    }

    await client.query("COMMIT");
    return { message, temporaryPassword };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
