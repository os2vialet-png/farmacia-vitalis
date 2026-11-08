import "server-only";

import { z } from "zod";
import { db } from "@/src/lib/db";
import { hasPermission, type AuthSession } from "@/src/lib/auth/permissions";
import { normalizeProductName } from "@/src/lib/catalog-create";
import { maskDocument } from "@/src/lib/customers";
import { centsToDecimal, toCents } from "@/src/lib/pos-math";
import { AiRateLimitError, chatCompletion, type ChatMessage, type ToolDefinition } from "@/src/lib/ai-client";
import {
  alertsSummary,
  branchesFor,
  interpretRules,
  lower,
  matchBranch,
  ROLE_LABELS,
  scopeBranchIds,
  SETTING_LABELS,
  suggestUsername,
  type AssistantReply,
  type Branch,
  type ChatTurn,
  type Proposal,
} from "@/src/lib/owner-assistant";

/**
 * Agente del asistente del dueño. Un modelo de IA entiende el mensaje (con el contexto de la
 * conversación) y usa HERRAMIENTAS del sistema:
 * - Consultas: se ejecutan de inmediato, siempre limitadas a las sucursales de la sesión.
 * - Acciones: solo PROPONEN; el usuario confirma con un botón y el servidor vuelve a validar
 *   permisos y datos (execute() o la API correspondiente).
 * La IA nunca escribe en la base de datos ni ve contraseñas.
 */

const MAX_STEPS = 6;
const MAX_TOOL_OUTPUT = 3000;

const SCREENS: Record<string, { path: string; label: string; search?: boolean }> = {
  inicio: { path: "/dashboard", label: "Inicio" },
  punto_de_venta: { path: "/pos", label: "Punto de venta" },
  historial_ventas: { path: "/ventas", label: "Historial de ventas" },
  clientes: { path: "/clientes", label: "Clientes", search: true },
  compras: { path: "/purchases", label: "Compras" },
  suplidores: { path: "/suppliers", label: "Suplidores" },
  inventario: { path: "/inventory", label: "Inventario" },
  transferencias: { path: "/transferencias", label: "Transferencias" },
  catalogo: { path: "/catalogo", label: "Catálogo", search: true },
  reportes: { path: "/reportes", label: "Reportes" },
  empleados: { path: "/users", label: "Empleados" },
  auditoria: { path: "/auditoria", label: "Auditoría" },
  configuracion: { path: "/configuracion", label: "Configuración" },
  asistente_publico: { path: "/asistente", label: "Asistente para clientes" },
};

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): ToolDefinition => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

// Descripciones cortas a propósito: el plan gratuito de la IA cuenta cada palabra enviada.
const S = { type: "string" };
const N = { type: "number" };
const product = { producto_id: S, producto: S };

const TOOLS: ToolDefinition[] = [
  fn("buscar_productos", "Existencias, precio y estado de productos por nombre o principio activo (tolera errores)", { texto: S }, ["texto"]),
  fn("resumen_negocio", "Avisos y resumen general"),
  fn("stock_bajo", "Qué hay que pedir"),
  fn("por_vencer", "Lotes vencidos o por vencer"),
  fn("ventas", "Ventas por sucursal, formas de pago y más vendidos", { periodo: { type: "string", enum: ["hoy", "ayer", "semana", "mes"] } }, ["periodo"]),
  fn("ultimas_ventas", "Ventas recientes", { cantidad: N }),
  fn("buscar_clientes", "Clientes por nombre o teléfono", { texto: S }, ["texto"]),
  fn("empleados", "Empleados, roles y estado"),
  fn("transferencias", "Transferencias entre sucursales", { estado: { type: "string", enum: ["pendientes", "todas"] } }),
  fn("compras", "Órdenes de compra", { estado: { type: "string", enum: ["abiertas", "todas"] } }),
  fn("suplidores", "Suplidores", { texto: S }),
  fn("abrir_pantalla", "Abre una pantalla del sistema", { pantalla: { type: "string", enum: Object.keys(SCREENS) }, buscar: S }, ["pantalla"]),
  fn("fijar_precio", "Propone precio de venta (RD$, impuesto incluido)", { ...product, monto: N, sucursal: S }, ["monto"]),
  fn("fijar_minimo", "Propone mínimo de reposición", { ...product, cantidad: N, sucursal: S }, ["cantidad"]),
  fn("crear_empleado", "Propone crear empleado", { nombre: S, apellido: S, rol: { type: "string", enum: ["vendedor", "farmaceutico", "encargado_inventario", "administrador"] }, sucursal: S, usuario: S }, ["nombre", "apellido", "rol", "sucursal"]),
  fn("desactivar_empleado", "Propone desactivar empleado", { usuario: S }, ["usuario"]),
  fn("crear_producto", "Propone agregar producto al catálogo", { nombre: S, forma: S, concentracion: S, presentacion: S, unidad: S, marca: S, registro_sanitario: S, requiere_receta: { type: "boolean" } }, ["nombre"]),
  fn("cambiar_configuracion", "Propone cambiar un texto del sistema", { campo: { type: "string", enum: ["nombre_farmacia", "pie_comprobante", "derivacion_clinica"] }, valor: S }, ["campo", "valor"]),
  fn("solicitar_transferencia", "Propone pedir mercancía de una sucursal a otra", { ...product, cantidad: N, desde: S, hacia: S, nota: S }, ["cantidad", "desde", "hacia"]),
  fn("aprobar_transferencia", "Propone aprobar transferencia", { numero: S }, ["numero"]),
  fn("despachar_transferencia", "Propone despachar transferencia", { numero: S }, ["numero"]),
  fn("registrar_cliente", "Propone registrar cliente", { nombre: S, telefono: S, cedula: S, correo: S, acepto_aviso_privacidad: { type: "boolean" } }, ["nombre"]),
  fn("registrar_suplidor", "Propone registrar suplidor", { nombre: S, telefono: S, contacto: S, rnc: S, correo: S }, ["nombre"]),
  fn("deshacer", "Propone revertir la última acción del asistente"),
];

function systemPrompt(session: AuthSession, branches: Branch[]): string {
  const today = new Intl.DateTimeFormat("es-DO", { dateStyle: "full", timeZone: "America/Santo_Domingo" }).format(new Date());
  const roles = session.roles.map((role) => role.code).join(", ");
  return `Eres Vita, asistente del dueño de Farmacia Vitalis (RD) dentro de su sistema. Hoy: ${today}. Usuario: ${session.user.firstName} (${roles}). Sucursales: ${branches.map((b) => b.name).join("; ")}.
Reglas:
- Datos del negocio SOLO de las herramientas; nunca inventes cifras ni productos.
- Usa el contexto: «y X?», «ni X?» repiten la consulta anterior con X.
- Nombres mal escritos o dictados: búscalos igual y di el nombre correcto. Paracetamol = acetaminofén en RD.
- Existencias: di cuáles tienen stock (por sucursal) y precio; si ninguno, dilo claro.
- «Sin verificar» = en catálogo pero no se vende hasta que un farmacéutico lo verifique y tenga unidad y precio.
- Para cambiar algo usa la herramienta «Propone…»: el usuario confirma con un botón. Nunca digas que ya se hizo.
- Si falta un dato (sucursal, monto, rol…) pregúntalo. Si un producto es ambiguo, da opciones y luego pasa su id como producto_id.
- Ofrece solo lo que tus herramientas pueden hacer (no reservas, no notificas, no registras consultas). Para abrir una pantalla llama a abrir_pantalla; nunca digas que la abriste sin llamarla.
- Sin diagnósticos, dosis ni sugerir medicamentos para síntomas: deriva al farmacéutico o médico.
- Breve, natural, español dominicano, sin tablas; listas con «- »; montos en RD$.`;
}

const SCREEN_WORDS: [RegExp, string][] = [
  [/\b(reporte|reportes|informe|informes|estadistica)/, "reportes"],
  [/\b(inventario|existencias)/, "inventario"],
  [/\b(catalogo|productos|medicamentos)/, "catalogo"],
  [/\b(cliente|clientes)/, "clientes"],
  [/\b(historial|ventas)/, "historial_ventas"],
  [/\b(pos|punto de venta|caja|vender|facturar)/, "punto_de_venta"],
  [/\b(compra|compras|ordenes)/, "compras"],
  [/\b(suplidor|suplidores|proveedor|proveedores)/, "suplidores"],
  [/\b(transferencia|transferencias)/, "transferencias"],
  [/\b(empleado|empleados|usuarios|personal)/, "empleados"],
  [/\b(auditoria)/, "auditoria"],
  [/\b(configuracion|ajustes)/, "configuracion"],
  [/\b(inicio|principal|dashboard|tablero)/, "inicio"],
];

/** «llévame a reportes», «abre el catálogo con amoxicilina»: se resuelve sin gastar la IA. */
function directNavigation(message: string): { pantalla: string; buscar: string } | null {
  const text = lower(message).replace(/[¿?¡!.]/g, "").trim();
  const match = /^(?:por favor\s+)?(?:llevame|abre|abreme|abrir|ve|vete|ir|vamos|muestrame|ensename|pasame)\s+(?:a\s+|al\s+|para\s+)?(?:la\s+|el\s+|los\s+|las\s+)?(?:pantalla|modulo|seccion|parte)?\s*(?:de\s+|del\s+)?(.+)$/.exec(text);
  if (!match) return null;
  const [target, search = ""] = match[1].split(/\s+(?:con|y busca|buscando|y buscame)\s+/);
  if (target.split(" ").length > 4) return null;
  const screen = SCREEN_WORDS.find(([pattern]) => pattern.test(target));
  return screen ? { pantalla: screen[1], buscar: search.trim() } : null;
}

/** Ejecuta el agente. Devuelve null si el servicio de IA falla (se usan las reglas). */
export async function runAgent(session: AuthSession, message: string, history: ChatTurn[]): Promise<AssistantReply | null> {
  const navigation = directNavigation(message);
  if (navigation) {
    const outcome = await runTool(session, [], "abrir_pantalla", navigation);
    return { reply: outcome.reply ?? "Abriendo.", navigate: outcome.navigate };
  }

  const branches = await branchesFor(session);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(session, branches) },
    ...history.slice(-8).map((turn) => ({ role: turn.role, content: turn.content.slice(0, 700) }) as ChatMessage),
    { role: "user", content: message },
  ];

  try {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      const result = await chatCompletion(messages, TOOLS);

      if (result.toolCalls.length === 0) {
        return { reply: result.content?.trim() || "No tengo una respuesta para eso. ¿Me lo dices de otra forma?" };
      }

      messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });

      for (const call of result.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(call.function.arguments || "{}");
          if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
        } catch {
          args = {};
        }

        const outcome = await runTool(session, branches, call.function.name, args);

        // Una propuesta o una navegación terminan el turno: el usuario debe actuar.
        if (outcome.proposal) {
          return { reply: outcome.reply ?? "Esto es lo que haré. Revísalo y confirma:", proposal: outcome.proposal };
        }
        if (outcome.navigate) {
          return { reply: outcome.reply ?? "Listo, abriendo la pantalla.", navigate: outcome.navigate };
        }

        messages.push({ role: "tool", tool_call_id: call.id, content: (outcome.data ?? "").slice(0, MAX_TOOL_OUTPUT) });
      }
    }
    return { reply: "La consulta necesitó demasiados pasos. ¿Puedes decirla de forma más concreta?" };
  } catch (error) {
    if (error instanceof AiRateLimitError) {
      return { reply: `Recibí muchas consultas seguidas y llegué al límite gratuito de la IA por este minuto. Intenta de nuevo en unos ${error.retrySeconds} segundos.` };
    }
    console.error("Agente del asistente:", error instanceof Error ? error.message : "error");
    return null;
  }
}

type ToolOutcome = { data?: string; proposal?: Proposal; navigate?: string; reply?: string };

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const number = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[^0-9.,-]/g, "").replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
};
const json = (value: unknown) => JSON.stringify(value);
const ask = (question: string): ToolOutcome => ({ data: `FALTA DATO: ${question}` });

function resolveBranch(branches: Branch[], term: string): Branch | ToolOutcome {
  const branch = matchBranch(branches, term || null);
  if (branch && branch !== "ambiguous") return branch;
  return ask(`¿En qué sucursal? Opciones: ${branches.map((b) => b.name).join(", ")}.`);
}
const isBranch = (value: Branch | ToolOutcome): value is Branch => "id" in value;

type ProductRow = {
  id: string;
  product_name: string;
  dosage_form: string | null;
  strength: string | null;
  presentation: string | null;
  verification_status: string;
  is_prescription: boolean;
  ingredient: string | null;
  score: number;
  stock: { sucursal: string; branch_id: string; disponible: number }[];
  prices: { sucursal: string; branch_id: string; precio: number }[];
};

/** Búsqueda aproximada por nombre y principio activo, con existencias y precios del alcance. */
/** Nombres que en el registro dominicano aparecen con otro nombre. */
const SYNONYMS: [RegExp, string][] = [
  [/\bp[ae]r[ae]?c[ei]tamol\b/g, "acetaminofen"],
  [/\bacetaminofeno\b/g, "acetaminofen"],
];

async function searchProducts(session: AuthSession, rawTerm: string, limit = 8): Promise<{ rows: ProductRow[]; total: number }> {
  const term = SYNONYMS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), normalizeProductName(rawTerm));
  if (term.length < 2) return { rows: [], total: 0 };
  const branchIds = await scopeBranchIds(session);

  const query = (filter: string) => db.query<ProductRow>(
    `WITH cand AS (
       SELECT p.id, p.product_name, p.dosage_form, p.strength, p.presentation, p.verification_status, p.is_prescription,
              p.source_data->>'active_ingredient_text' AS ingredient,
              GREATEST(farmacia.word_similarity($1, p.normalized_name),
                       farmacia.word_similarity($1, upper(coalesce(p.source_data->>'active_ingredient_text', ''))) * 0.9)::float AS score
       FROM farmacia.catalog_products p
       WHERE p.is_active AND p.duplicate_of_product_id IS NULL AND (${filter})
       -- Primero lo que se tiene en existencia o con precio en las sucursales del usuario.
       ORDER BY EXISTS (SELECT 1 FROM farmacia.inventory_stock s WHERE s.product_id = p.id AND s.branch_id = ANY($2::uuid[])
                          AND s.quantity_on_hand - s.quantity_reserved > 0) DESC,
                EXISTS (SELECT 1 FROM farmacia.product_branch_prices pr WHERE pr.product_id = p.id AND pr.branch_id = ANY($2::uuid[])
                          AND pr.effective_until IS NULL) DESC,
                score DESC, length(p.normalized_name)
       LIMIT 60)
     SELECT c.*,
       COALESCE((SELECT json_agg(json_build_object('sucursal', b.name, 'branch_id', b.id, 'disponible', (s.quantity_on_hand - s.quantity_reserved)::float))
                 FROM farmacia.inventory_stock s JOIN farmacia.branches b ON b.id = s.branch_id
                 WHERE s.product_id = c.id AND s.branch_id = ANY($2::uuid[])), '[]'::json) AS stock,
       COALESCE((SELECT json_agg(json_build_object('sucursal', b.name, 'branch_id', b.id, 'precio', pr.sale_price::float))
                 FROM farmacia.product_branch_prices pr JOIN farmacia.branches b ON b.id = pr.branch_id
                 WHERE pr.product_id = c.id AND pr.branch_id = ANY($2::uuid[])
                   AND pr.effective_from <= NOW() AND (pr.effective_until IS NULL OR pr.effective_until > NOW())), '[]'::json) AS prices
     FROM cand c`,
    [term, branchIds],
  );

  let result = await query(
    `$1 OPERATOR(farmacia.<%) p.normalized_name OR $1 OPERATOR(farmacia.<%) upper(p.source_data->>'active_ingredient_text')`,
  );
  if (result.rows.length === 0) {
    result = await query(`farmacia.word_similarity($1, p.normalized_name) > 0.35`);
  }

  const weight = (row: ProductRow) =>
    (row.stock.some((s) => s.disponible > 0) ? 2 : 0) + (row.prices.length > 0 ? 1 : 0) + (row.verification_status === "verified" ? 0.5 : 0) + row.score;
  const rows = [...result.rows].sort((a, b) => weight(b) - weight(a));
  return { rows: rows.slice(0, limit), total: rows.length };
}

function describeProduct(row: ProductRow): string {
  return [row.product_name, row.strength, row.dosage_form, row.presentation].filter(Boolean).join(" · ");
}

/** Elige un producto para una acción, o devuelve la pregunta para desambiguar. */
async function resolveProduct(session: AuthSession, args: Record<string, unknown>, branchId?: string): Promise<{ id: string; name: string } | ToolOutcome> {
  const id = text(args.producto_id);
  if (id && z.string().uuid().safeParse(id).success) {
    const found = await db.query<{ id: string; product_name: string }>(
      `SELECT id, product_name FROM farmacia.catalog_products WHERE id = $1 AND is_active`, [id]);
    if (found.rows[0]) return { id: found.rows[0].id, name: found.rows[0].product_name };
  }
  const name = text(args.producto);
  if (!name) return ask("¿De qué producto?");

  const { rows } = await searchProducts(session, name, 8);
  if (rows.length === 0) return { data: `NO ENCONTRADO: no hay un producto activo parecido a «${name}».` };

  const inBranch = branchId ? rows.filter((r) => r.stock.some((s) => s.branch_id === branchId) || r.prices.some((p) => p.branch_id === branchId)) : [];
  const chosen = rows.length === 1 ? rows[0] : inBranch.length === 1 ? inBranch[0] : null;
  if (chosen) return { id: chosen.id, name: describeProduct(chosen) };

  return {
    data: `AMBIGUO: hay varios productos parecidos a «${name}». Pregunta cuál y luego usa su producto_id:\n${json(
      rows.map((r) => ({ producto_id: r.id, producto: describeProduct(r), verificado: r.verification_status === "verified", existencias: r.stock.map((s) => `${s.sucursal}: ${s.disponible}`) })),
    )}`,
  };
}
const isProduct = (value: { id: string; name: string } | ToolOutcome): value is { id: string; name: string } => "id" in value && "name" in value;

const PERIOD_DAYS: Record<string, { from: number; to: number; label: string }> = {
  hoy: { from: 0, to: 0, label: "hoy" },
  ayer: { from: 1, to: 1, label: "ayer" },
  semana: { from: 6, to: 0, label: "los últimos 7 días" },
  mes: { from: 29, to: 0, label: "los últimos 30 días" },
};

const LOCAL_DAY = `(now() AT TIME ZONE 'America/Santo_Domingo')::date`;

async function findTransfer(session: AuthSession, numero: string) {
  const branchIds = await scopeBranchIds(session);
  const digits = numero.replace(/\D/g, "");
  const rows = await db.query<{ id: string; transfer_number: string; status: string; origin: string; destination: string }>(
    `SELECT t.id, t.transfer_number, t.status, o.name AS origin, d.name AS destination
     FROM farmacia.transfers t
     JOIN farmacia.branches o ON o.id = t.origin_branch_id
     JOIN farmacia.branches d ON d.id = t.destination_branch_id
     WHERE (t.origin_branch_id = ANY($1::uuid[]) OR t.destination_branch_id = ANY($1::uuid[]))
       AND (UPPER(t.transfer_number) = UPPER($2) OR ($3 <> '' AND t.transfer_number LIKE '%' || lpad($3, 6, '0')))
     ORDER BY t.requested_at DESC LIMIT 2`,
    [branchIds, numero.trim(), digits.slice(-6)],
  );
  return rows.rows.length === 1 ? rows.rows[0] : null;
}

async function runTool(session: AuthSession, branches: Branch[], name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const branchIds = await scopeBranchIds(session);

  switch (name) {
    case "buscar_productos": {
      const { rows, total } = await searchProducts(session, text(args.texto), 6);
      if (rows.length === 0) return { data: `Sin resultados para «${text(args.texto)}» en el catálogo.` };
      const withStock = rows.filter((r) => r.stock.some((s) => s.disponible > 0)).length;
      return {
        data: json({
          coincidencias: total >= 60 ? "más de 60" : total,
          con_existencia: withStock,
          productos: rows.map((r) => ({
            id: r.id,
            producto: describeProduct(r),
            activo: r.ingredient?.slice(0, 60) ?? null,
            verificado: r.verification_status === "verified",
            receta: r.is_prescription || undefined,
            stock: r.stock.map((s) => `${s.sucursal}: ${s.disponible}`),
            precio: r.prices.map((p) => `${p.sucursal}: RD$${p.precio}`),
          })),
        }),
      };
    }

    case "resumen_negocio": {
      const summary = await alertsSummary(session);
      return { data: [summary.reply, ...(summary.bullets ?? [])].join("\n") };
    }

    case "stock_bajo":
    case "por_vencer": {
      const result = await interpretRules(session, name === "stock_bajo" ? "stock bajo" : "por vencer");
      return { data: [result.reply, ...(result.bullets ?? [])].join("\n") };
    }

    case "ventas": {
      const period = PERIOD_DAYS[text(args.periodo)] ?? PERIOD_DAYS.hoy;
      const range = [branchIds, period.from, period.to];
      const where = `s.branch_id = ANY($1::uuid[]) AND s.status = 'completed'
        AND s.created_at >= (${LOCAL_DAY} - $2::int)::timestamp AT TIME ZONE 'America/Santo_Domingo'
        AND s.created_at < (${LOCAL_DAY} - $3::int + 1)::timestamp AT TIME ZONE 'America/Santo_Domingo'`;
      const [byBranch, top, payments] = await Promise.all([
        db.query(`SELECT b.name AS sucursal, COUNT(s.id)::int AS ventas, COALESCE(SUM(s.total), 0)::float AS total_rd
                  FROM farmacia.branches b LEFT JOIN farmacia.sales s ON s.branch_id = b.id AND ${where.replace("s.branch_id = ANY($1::uuid[]) AND ", "")}
                  WHERE b.id = ANY($1::uuid[]) GROUP BY b.name ORDER BY b.name`, range),
        db.query(`SELECT p.product_name AS producto, SUM(si.quantity)::float AS unidades, SUM(si.line_total)::float AS total_rd
                  FROM farmacia.sales s JOIN farmacia.sale_items si ON si.sale_id = s.id JOIN farmacia.catalog_products p ON p.id = si.product_id
                  WHERE ${where} GROUP BY p.product_name ORDER BY unidades DESC LIMIT 5`, range),
        db.query(`SELECT sp.method AS forma, SUM(sp.amount)::float AS total_rd
                  FROM farmacia.sales s JOIN farmacia.sale_payments sp ON sp.sale_id = s.id
                  WHERE ${where} GROUP BY sp.method`, range),
      ]);
      return { data: json({ periodo: period.label, por_sucursal: byBranch.rows, mas_vendidos: top.rows, formas_de_pago: payments.rows }) };
    }

    case "ultimas_ventas": {
      const count = Math.min(Math.max(number(args.cantidad) ?? 8, 1), 15);
      const rows = await db.query(
        `SELECT s.sale_number AS numero, b.name AS sucursal, u.first_name || ' ' || u.last_name AS cajero, s.total::float AS total_rd, s.status AS estado,
                to_char(s.created_at AT TIME ZONE 'America/Santo_Domingo', 'DD/MM HH12:MI AM') AS fecha
         FROM farmacia.sales s JOIN farmacia.branches b ON b.id = s.branch_id LEFT JOIN farmacia.users u ON u.id = s.cashier_id
         WHERE s.branch_id = ANY($1::uuid[]) ORDER BY s.created_at DESC LIMIT $2`,
        [branchIds, count],
      );
      return { data: json(rows.rows) };
    }

    case "buscar_clientes": {
      if (!hasPermission(session, "customers.view")) return { data: "SIN PERMISO para ver clientes." };
      const term = text(args.texto);
      const rows = await db.query<{ full_name: string; phone: string | null; document_number: string | null; is_active: boolean }>(
        `SELECT full_name, phone, document_number, is_active FROM farmacia.customers
         WHERE full_name ILIKE '%' || $1 || '%' OR regexp_replace(coalesce(phone, ''), '\\D', '', 'g') LIKE '%' || regexp_replace($1, '\\D', '', 'g') || '%' AND length(regexp_replace($1, '\\D', '', 'g')) >= 4
         ORDER BY is_active DESC, full_name LIMIT 10`,
        [term],
      );
      return { data: json(rows.rows.map((r) => ({ nombre: r.full_name, telefono: r.phone, documento: maskDocument(r.document_number), activo: r.is_active }))) };
    }

    case "empleados": {
      const rows = await db.query(
        `SELECT u.username AS usuario, u.first_name || ' ' || u.last_name AS nombre, u.is_active AS activo,
                u.must_change_password AS contrasena_temporal,
                COALESCE(string_agg(DISTINCT r.code || COALESCE(' en ' || b.name, ''), ', '), '') AS roles
         FROM farmacia.users u
         LEFT JOIN farmacia.user_roles ur ON ur.user_id = u.id
         LEFT JOIN farmacia.roles r ON r.id = ur.role_id
         LEFT JOIN farmacia.branches b ON b.id = ur.branch_id
         GROUP BY u.id ORDER BY u.is_active DESC, u.first_name LIMIT 60`,
      );
      return { data: json(rows.rows) };
    }

    case "transferencias": {
      const pending = text(args.estado) !== "todas";
      const rows = await db.query(
        `SELECT t.transfer_number AS numero, t.status AS estado, o.name AS desde, d.name AS hacia,
                to_char(t.requested_at AT TIME ZONE 'America/Santo_Domingo', 'DD/MM/YYYY') AS fecha,
                (SELECT string_agg(p.product_name || ' x' || ti.quantity_requested::int, ', ')
                   FROM farmacia.transfer_items ti JOIN farmacia.catalog_products p ON p.id = ti.product_id WHERE ti.transfer_id = t.id) AS productos
         FROM farmacia.transfers t
         JOIN farmacia.branches o ON o.id = t.origin_branch_id JOIN farmacia.branches d ON d.id = t.destination_branch_id
         WHERE (t.origin_branch_id = ANY($1::uuid[]) OR t.destination_branch_id = ANY($1::uuid[]))
           AND (NOT $2 OR t.status IN ('requested', 'approved', 'in_transit'))
         ORDER BY t.requested_at DESC LIMIT 15`,
        [branchIds, pending],
      );
      return { data: json({ nota: "requested=solicitada, approved=aprobada, in_transit=en camino, received=recibida", transferencias: rows.rows }) };
    }

    case "compras": {
      const open = text(args.estado) !== "todas";
      const rows = await db.query(
        `SELECT po.order_number AS numero, po.status AS estado, sp.name AS suplidor, b.name AS sucursal, po.total_amount::float AS total_rd,
                to_char(po.order_date, 'DD/MM/YYYY') AS fecha
         FROM farmacia.purchase_orders po JOIN farmacia.suppliers sp ON sp.id = po.supplier_id JOIN farmacia.branches b ON b.id = po.branch_id
         WHERE po.branch_id = ANY($1::uuid[]) AND (NOT $2 OR po.status NOT IN ('received', 'cancelled'))
         ORDER BY po.created_at DESC LIMIT 15`,
        [branchIds, open],
      );
      return { data: json(rows.rows) };
    }

    case "suplidores": {
      const rows = await db.query(
        `SELECT name AS nombre, contact_name AS contacto, phone AS telefono, is_active AS activo FROM farmacia.suppliers
         WHERE $1 = '' OR name ILIKE '%' || $1 || '%' OR commercial_name ILIKE '%' || $1 || '%'
         ORDER BY is_active DESC, name LIMIT 20`,
        [text(args.texto)],
      );
      return { data: json(rows.rows) };
    }

    case "abrir_pantalla": {
      const screen = SCREENS[text(args.pantalla)];
      if (!screen) return { data: `Pantalla desconocida. Opciones: ${Object.keys(SCREENS).join(", ")}.` };
      const search = text(args.buscar);
      const path = screen.search && search ? `${screen.path}?q=${encodeURIComponent(search)}` : screen.path;
      return { navigate: path, reply: `Abriendo ${screen.label}${screen.search && search ? ` con «${search}»` : ""}.` };
    }

    case "fijar_precio": {
      const amount = number(args.monto);
      if (amount === null || amount <= 0) return ask("¿A qué precio?");
      const branch = resolveBranch(branches, text(args.sucursal));
      if (!isBranch(branch)) return branch;
      const product = await resolveProduct(session, args, branch.id);
      if (!isProduct(product)) return product;
      return {
        proposal: {
          action: "set_price",
          params: { productId: product.id, branchId: branch.id, salePrice: amount },
          summary: [`Fijar el precio de ${product.name} en RD$ ${centsToDecimal(toCents(amount))} (impuesto incluido) en ${branch.name}.`, "El precio anterior queda en el historial. «deshacer» lo restaura."],
        },
      };
    }

    case "fijar_minimo": {
      const quantity = number(args.cantidad);
      if (quantity === null || quantity < 0) return ask("¿Cuántas unidades de mínimo?");
      const branch = resolveBranch(branches, text(args.sucursal));
      if (!isBranch(branch)) return branch;
      const product = await resolveProduct(session, args, branch.id);
      if (!isProduct(product)) return product;
      return {
        proposal: {
          action: "set_stock_levels",
          params: { productId: product.id, branchId: branch.id, minimum: Math.round(quantity) },
          summary: [`Fijar el mínimo de ${product.name} en ${Math.round(quantity)} unidades en ${branch.name}.`, "Al llegar a ese nivel aparecerá en los avisos."],
        },
      };
    }

    case "crear_empleado": {
      const roleMap: Record<string, string> = { vendedor: "seller", farmaceutico: "pharmacist", encargado_inventario: "inventory_manager", administrador: "admin" };
      const role = roleMap[text(args.rol)];
      const firstName = text(args.nombre);
      const lastName = text(args.apellido);
      if (!firstName || !lastName) return ask("¿Nombre y apellido del empleado?");
      if (!role) return ask("¿Qué rol: vendedor, farmacéutico, encargado de inventario o administrador?");
      const branch = resolveBranch(branches, text(args.sucursal));
      if (!isBranch(branch)) return branch;
      const username = (text(args.usuario) || suggestUsername(firstName, lastName)).toLowerCase().replace(/[^a-z0-9._-]/g, "");
      return {
        proposal: {
          action: "create_employee",
          params: { firstName, lastName, username, roleCode: role, branchId: branch.id },
          summary: [`Crear a ${firstName} ${lastName} como ${ROLE_LABELS[role]} en ${branch.name}.`, `Usuario: ${username}. Tendrá una contraseña temporal que deberá cambiar al entrar.`],
        },
      };
    }

    case "desactivar_empleado": {
      const term = text(args.usuario);
      const users = await db.query<{ id: string; username: string; first_name: string; last_name: string; is_active: boolean }>(
        `SELECT id, username, first_name, last_name, is_active FROM farmacia.users
         WHERE LOWER(username) = LOWER($1) OR (first_name || ' ' || last_name) ILIKE '%' || $1 || '%' LIMIT 5`,
        [term],
      );
      if (users.rows.length === 0) return { data: `NO ENCONTRADO: ningún empleado «${term}».` };
      if (users.rows.length > 1) return { data: `AMBIGUO: ${json(users.rows.map((u) => ({ usuario: u.username, nombre: `${u.first_name} ${u.last_name}` })))}` };
      const user = users.rows[0];
      if (!user.is_active) return { data: `${user.first_name} ${user.last_name} ya está desactivado.` };
      return {
        proposal: {
          action: "deactivate_employee",
          params: { userId: user.id },
          summary: [`Desactivar a ${user.first_name} ${user.last_name} (${user.username}).`, "Sus sesiones abiertas se cerrarán. «deshacer» lo reactiva."],
        },
      };
    }

    case "crear_producto": {
      const productName = text(args.nombre).toUpperCase();
      if (productName.length < 2) return ask("¿Cómo se llama el producto?");
      const params = {
        productName,
        dosageForm: text(args.forma) || undefined,
        strength: text(args.concentracion) || undefined,
        presentation: text(args.presentacion) || undefined,
        brandName: text(args.marca) || undefined,
        saleUnit: text(args.unidad) || undefined,
        sanitaryRegistration: text(args.registro_sanitario).toUpperCase() || undefined,
        taxPercent: null,
        isPrescription: args.requiere_receta === true,
      };
      const detail = [params.dosageForm, params.strength, params.presentation, params.brandName && `marca ${params.brandName}`, params.saleUnit && `unidad ${params.saleUnit}`].filter(Boolean).join(", ");
      return {
        proposal: {
          action: "create_product",
          params,
          summary: [`Crear el producto ${productName}${detail ? ` (${detail})` : ""}.`, "Quedará pendiente de verificación: no se vende hasta que un farmacéutico lo verifique."],
        },
      };
    }

    case "cambiar_configuracion": {
      const keyMap: Record<string, string> = { nombre_farmacia: "pharmacy_name", pie_comprobante: "receipt_footer", derivacion_clinica: "clinical_referral_text" };
      const key = keyMap[text(args.campo)];
      const value = text(args.valor);
      if (!key || !value) return ask("¿Qué texto quieres poner?");
      return { proposal: { action: "update_setting", params: { key, value }, summary: [`Cambiar «${SETTING_LABELS[key]}» a: ${value}`] } };
    }

    case "solicitar_transferencia": {
      const quantity = number(args.cantidad);
      if (quantity === null || quantity < 1) return ask("¿Cuántas unidades?");
      const origin = resolveBranch(branches, text(args.desde));
      if (!isBranch(origin)) return ask(`¿Desde qué sucursal se envía? Opciones: ${branches.map((b) => b.name).join(", ")}.`);
      const destination = resolveBranch(branches, text(args.hacia));
      if (!isBranch(destination)) return ask(`¿Para qué sucursal? Opciones: ${branches.map((b) => b.name).join(", ")}.`);
      if (origin.id === destination.id) return ask("La sucursal que envía y la que recibe deben ser distintas.");
      const product = await resolveProduct(session, args, origin.id);
      if (!isProduct(product)) return product;
      const qty = Math.round(quantity);
      return {
        proposal: {
          action: "api_request",
          params: {},
          summary: [`Solicitar ${qty} unidad(es) de ${product.name}: de ${origin.name} hacia ${destination.name}.`, "La sucursal de origen deberá aprobarla y despacharla."],
          request: {
            method: "POST",
            path: "/api/transfers",
            body: { originBranchId: origin.id, destinationBranchId: destination.id, notes: text(args.nota) || "Solicitada con el asistente", items: [{ productId: product.id, quantity: qty }] },
            successText: "Transferencia solicitada.",
          },
        },
      };
    }

    case "aprobar_transferencia":
    case "despachar_transferencia": {
      const transfer = await findTransfer(session, text(args.numero));
      if (!transfer) return { data: `NO ENCONTRADA: no hay una transferencia única con el número «${text(args.numero)}». Usa la herramienta transferencias para ver los números.` };
      if (name === "aprobar_transferencia") {
        if (transfer.status !== "requested") return { data: `La transferencia ${transfer.transfer_number} está en estado ${transfer.status}; solo se aprueban las solicitadas.` };
        const items = await db.query<{ id: string; quantity_requested: string; product_name: string }>(
          `SELECT ti.id, ti.quantity_requested::text, p.product_name FROM farmacia.transfer_items ti JOIN farmacia.catalog_products p ON p.id = ti.product_id WHERE ti.transfer_id = $1`,
          [transfer.id],
        );
        return {
          proposal: {
            action: "api_request",
            params: {},
            summary: [`Aprobar ${transfer.transfer_number} (${transfer.origin} → ${transfer.destination}):`, ...items.rows.map((i) => `${i.product_name}: ${Number(i.quantity_requested)} unidad(es)`)],
            request: {
              method: "POST",
              path: `/api/transfers/${transfer.id}/approve`,
              body: { items: items.rows.map((i) => ({ itemId: i.id, quantityApproved: Number(i.quantity_requested) })) },
              successText: `Transferencia ${transfer.transfer_number} aprobada.`,
            },
          },
        };
      }
      if (transfer.status !== "approved") return { data: `La transferencia ${transfer.transfer_number} está en estado ${transfer.status}; solo se despachan las aprobadas.` };
      return {
        proposal: {
          action: "api_request",
          params: {},
          summary: [`Despachar ${transfer.transfer_number} (${transfer.origin} → ${transfer.destination}).`, `Se descuenta el inventario de ${transfer.origin} por lotes que vencen primero.`],
          request: { method: "POST", path: `/api/transfers/${transfer.id}/dispatch`, body: null, successText: `Transferencia ${transfer.transfer_number} despachada.` },
        },
      };
    }

    case "registrar_cliente": {
      const fullName = text(args.nombre);
      if (fullName.length < 2) return ask("¿Nombre completo del cliente?");
      if (args.acepto_aviso_privacidad !== true) {
        return ask("Antes de registrarlo, ¿el cliente aceptó el aviso de tratamiento de sus datos personales?");
      }
      const body: Record<string, unknown> = { fullName, privacyAccepted: true };
      if (text(args.telefono)) body.phone = text(args.telefono);
      if (text(args.cedula)) body.documentNumber = text(args.cedula).replace(/\s/g, "");
      if (text(args.correo)) body.email = text(args.correo);
      return {
        proposal: {
          action: "api_request",
          params: {},
          summary: [`Registrar al cliente ${fullName}${body.phone ? `, tel. ${String(body.phone)}` : ""}.`, "Queda constancia de que aceptó el aviso de privacidad. Sin consentimientos comerciales."],
          request: { method: "POST", path: "/api/customers", body, successText: `Cliente ${fullName} registrado.` },
        },
      };
    }

    case "registrar_suplidor": {
      const supplierName = text(args.nombre);
      if (supplierName.length < 2) return ask("¿Nombre del suplidor?");
      const body: Record<string, unknown> = { name: supplierName };
      if (text(args.telefono)) body.phone = text(args.telefono);
      if (text(args.contacto)) body.contactName = text(args.contacto);
      if (text(args.rnc)) body.taxId = text(args.rnc);
      if (text(args.correo)) body.email = text(args.correo);
      return {
        proposal: {
          action: "api_request",
          params: {},
          summary: [`Registrar el suplidor ${supplierName}${body.contactName ? `, contacto ${String(body.contactName)}` : ""}${body.phone ? `, tel. ${String(body.phone)}` : ""}.`],
          request: { method: "POST", path: "/api/suppliers", body, successText: `Suplidor ${supplierName} registrado.` },
        },
      };
    }

    case "deshacer": {
      const result = await interpretRules(session, "deshacer");
      return result.proposal ? { proposal: result.proposal, reply: result.reply } : { data: result.reply };
    }

    default:
      return { data: `Herramienta desconocida: ${name}.` };
  }
}
