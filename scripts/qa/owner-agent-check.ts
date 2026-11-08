/**
 * Prueba del AGENTE del asistente del dueño con un servicio de IA SIMULADO (no gasta cuota ni
 * necesita clave). El simulador ordena llamar a cada herramienta y devuelve su resultado, así se
 * comprueban las consultas reales a la base, las propuestas, la navegación, el audio y el respaldo.
 *
 * 1. npm run qa:setup
 * 2. Iniciar el servidor de producción en el puerto 3100 con:
 *      AI_API_KEY=simulada  AI_BASE_URL=http://127.0.0.1:4599/v1
 * 3. npx tsx scripts/qa/owner-agent-check.ts
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const BASE = "http://localhost:3100";
const accounts = new Map(
  (JSON.parse(readFileSync(join(ROOT, "backups", "qa-accounts.json"), "utf8")).accounts as { username: string; password: string }[])
    .map((a) => [a.username, a.password]),
);

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${!ok && detail ? ` | ${detail.slice(0, 400)}` : ""}`);
}

type Msg = { role: string; content?: string | null; tool_call_id?: string };
let chatCalls = 0;
let lastToolCount = 0;
let lastSystem = "";

/** Simulador compatible con OpenAI. «@herramienta {json}» → llama a esa herramienta. */
const mock = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.endsWith("/audio/transcriptions")) {
      res.end(JSON.stringify({ text: "cuanto vendimos hoy" }));
      return;
    }
    chatCalls++;
    const body = JSON.parse(raw) as { messages: Msg[]; tools: unknown[] };
    lastToolCount = body.tools?.length ?? 0;
    lastSystem = body.messages[0]?.content ?? "";
    const last = body.messages[body.messages.length - 1];
    const reply = (message: object) => res.end(JSON.stringify({ choices: [{ message }] }));

    if (last.role === "tool") return reply({ role: "assistant", content: `RESULTADO ${last.content}` });
    const content = String(last.content ?? "");
    if (content === "@falla") { res.statusCode = 500; res.end("{}"); return; }
    if (content === "@eco") return reply({ role: "assistant", content: `ECO ${body.messages.length}` });
    const match = /^@(\w+)\s*(.*)$/.exec(content);
    if (!match) return reply({ role: "assistant", content: "Hola, ¿en qué te ayudo?" });
    return reply({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `call_${chatCalls}`, type: "function", function: { name: match[1], arguments: match[2] || "{}" } }],
    });
  });
});

async function cookie(username: string) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: accounts.get(username) }) });
  return (r.headers.get("set-cookie") ?? "").split(";")[0];
}

async function ask(c: string, message: string, history: { role: string; content: string }[] = []) {
  const r = await fetch(`${BASE}/api/owner-assistant`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify({ message, history }) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

const tool = (name: string, args: object = {}) => `@${name} ${JSON.stringify(args)}`;

async function main() {
  await new Promise<void>((done) => mock.listen(4599, "127.0.0.1", done));
  const owner = await cookie("qa_owner");
  const seller = await cookie("qa_seller_b1");

  const denied = await ask(seller, tool("empleados"));
  check("vendedor no puede usar el agente -> 403", denied.status === 403, String(denied.status));

  const before = chatCalls;
  const quick = await ask(owner, "avisos");
  check("botón «avisos» responde sin IA", quick.status === 200 && chatCalls === before && Array.isArray(quick.body.bullets));

  const talk = await ask(owner, "hola");
  check("conversación libre usa la IA con 24 herramientas", talk.status === 200 && lastToolCount === 24 && /Vitalis/.test(lastSystem), `${lastToolCount} ${JSON.stringify(talk.body)}`);

  const eco = await ask(owner, "@eco", [{ role: "user", content: "¿tenemos winasorb?" }, { role: "assistant", content: "Sí, en catálogo." }]);
  check("envía el historial de la conversación", eco.body.reply === "ECO 4", String(eco.body.reply));

  const typo = await ask(owner, tool("buscar_productos", { texto: "winnasord ultra" }));
  check("búsqueda tolera errores: winnasord → WINASORB ULTRA", /WINASORB ULTRA/.test(String(typo.body.reply)), String(typo.body.reply));

  const ingredient = await ask(owner, tool("buscar_productos", { texto: "acetaminofen" }));
  check("busca por principio activo (acetaminofén)", /ACETAMINOF/i.test(String(ingredient.body.reply)), String(ingredient.body.reply));

  const demo = await ask(owner, tool("buscar_productos", { texto: "loratadina" }));
  check("productos con existencias salen primero", /LORATADINA 10 MG \(DEMO\)/.test(String(demo.body.reply).slice(0, 400)), String(demo.body.reply).slice(0, 400));

  for (const [name, args, pattern] of [
    ["resumen_negocio", {}, /Ventas de hoy/],
    ["stock_bajo", {}, /reponer|No hay productos/],
    ["por_vencer", {}, /vencer|vence/i],
    ["ventas", { periodo: "semana" }, /por_sucursal/],
    ["ultimas_ventas", { cantidad: 3 }, /numero/],
    ["buscar_clientes", { texto: "demo" }, /RESULTADO \[/],
    ["empleados", {}, /usuario/],
    ["transferencias", { estado: "todas" }, /transferencias/],
    ["compras", { estado: "todas" }, /RESULTADO \[/],
    ["suplidores", {}, /RESULTADO \[/],
  ] as const) {
    const result = await ask(owner, tool(name, args));
    check(`herramienta ${name}`, result.status === 200 && pattern.test(String(result.body.reply)), String(result.body.reply));
  }

  const nav = await ask(owner, tool("abrir_pantalla", { pantalla: "catalogo", buscar: "amoxicilina" }));
  check("abre pantallas con búsqueda", nav.body.navigate === "/catalogo?q=amoxicilina", JSON.stringify(nav.body));

  const priceAsk = await ask(owner, tool("fijar_precio", { producto: "loratadina", monto: 95 }));
  check("acción sin sucursal pregunta cuál", /FALTA DATO/.test(String(priceAsk.body.reply)) && !priceAsk.body.proposal, JSON.stringify(priceAsk.body));

  const price = await ask(owner, tool("fijar_precio", { producto: "loratadina", monto: 95, sucursal: "Villa Mella" }));
  const priceProposal = price.body.proposal as { action: string; summary: string[] } | undefined;
  check("propone precio eligiendo el producto con existencias en esa sucursal", priceProposal?.action === "set_price" && /DEMO/.test(priceProposal.summary.join(" ")), JSON.stringify(price.body));

  const employee = await ask(owner, tool("crear_empleado", { nombre: "Ana", apellido: "Prueba", rol: "vendedor", sucursal: "Villa Mella" }));
  check("propone crear empleado", (employee.body.proposal as { action?: string } | undefined)?.action === "create_employee", JSON.stringify(employee.body));

  const transfer = await ask(owner, tool("solicitar_transferencia", { producto: "loratadina", cantidad: 2, desde: "Villa Mella", hacia: "Santiago" }));
  const transferProposal = transfer.body.proposal as { action: string; request?: { path: string; body: { items: unknown[] } } } | undefined;
  check("propone transferencia con llamada a /api/transfers", transferProposal?.action === "api_request" && transferProposal.request?.path === "/api/transfers" && transferProposal.request.body.items.length === 1, JSON.stringify(transfer.body));

  const customer = await ask(owner, tool("registrar_cliente", { nombre: "Cliente Prueba" }));
  check("registrar cliente exige el aviso de privacidad", /FALTA DATO/.test(String(customer.body.reply)) && !customer.body.proposal, JSON.stringify(customer.body));

  const supplier = await ask(owner, tool("registrar_suplidor", { nombre: "Suplidor Prueba", telefono: "809-555-0100" }));
  check("propone registrar suplidor", (supplier.body.proposal as { request?: { path: string } } | undefined)?.request?.path === "/api/suppliers", JSON.stringify(supplier.body));

  const setting = await ask(owner, tool("cambiar_configuracion", { campo: "pie_comprobante", valor: "Gracias" }));
  check("propone cambiar configuración", (setting.body.proposal as { action?: string } | undefined)?.action === "update_setting");

  const unknownTransfer = await ask(owner, tool("aprobar_transferencia", { numero: "TRF-0000-999999" }));
  check("transferencia inexistente no propone nada", /NO ENCONTRADA/.test(String(unknownTransfer.body.reply)) && !unknownTransfer.body.proposal);

  const fallback = await ask(owner, "@falla");
  check("si la IA falla responde con las reglas (sin error)", fallback.status === 200 && typeof fallback.body.reply === "string", JSON.stringify(fallback.body));

  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(2048)], { type: "audio/webm" }), "nota.webm");
  const audio = await fetch(`${BASE}/api/owner-assistant/transcribe`, { method: "POST", headers: { Cookie: owner }, body: form });
  const audioBody = (await audio.json()) as Record<string, unknown>;
  check("transcribe notas de voz", audio.status === 200 && audioBody.text === "cuanto vendimos hoy", JSON.stringify(audioBody));

  const badAudio = new FormData();
  badAudio.append("audio", new Blob(["hola"], { type: "text/plain" }), "x.txt");
  const bad = await fetch(`${BASE}/api/owner-assistant/transcribe`, { method: "POST", headers: { Cookie: owner }, body: badAudio });
  check("rechaza archivos que no son audio -> 415", bad.status === 415, String(bad.status));

  const sellerAudio = await fetch(`${BASE}/api/owner-assistant/transcribe`, { method: "POST", headers: { Cookie: seller }, body: form });
  check("vendedor no puede transcribir -> 403", sellerAudio.status === 403, String(sellerAudio.status));

  mock.close();
  console.log(`\nResultado: ${passed} correctas, ${failed} fallidas`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  mock.close();
  process.exitCode = 1;
});
