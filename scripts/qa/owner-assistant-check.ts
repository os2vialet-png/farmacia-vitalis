/**
 * Prueba del asistente del dueño contra el servidor en http://localhost:3100.
 * Requiere `npm run qa:setup`. Crea y desactiva una cuenta qa_asistente (QA).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";

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
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${!ok && detail ? ` | ${detail}` : ""}`);
}

async function cookie(username: string) {
  const r = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username, password: accounts.get(username) }) });
  return (r.headers.get("set-cookie") ?? "").split(";")[0];
}

async function ask(c: string, body: unknown) {
  const r = await fetch(`${BASE}/api/owner-assistant`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: c }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function main() {
  const db = new Client({ connectionString: readFileSync(join(ROOT, ".env.local"), "utf8").match(/^DATABASE_URL=(.*)$/m)![1].trim().replace(/^"|"$/g, "") });
  await db.connect();
  await db.query(`DELETE FROM farmacia.user_roles WHERE user_id IN (SELECT id FROM farmacia.users WHERE username = 'qa_asistente')`);
  await db.query(`UPDATE farmacia.users SET username = 'qa_asistente_old_' || substr(md5(random()::text), 1, 6) WHERE username = 'qa_asistente'`);

  const owner = await cookie("qa_owner");
  const seller = await cookie("qa_seller_b1");

  const denied = await ask(seller, { message: "avisos" });
  check("vendedor no puede usar el asistente del dueño -> 403", denied.status === 403, String(denied.status));

  const alerts = await ask(owner, { message: "avisos" });
  check("avisos devuelve resumen", alerts.status === 200 && Array.isArray(alerts.body.bullets) && (alerts.body.bullets as string[]).length >= 6, JSON.stringify(alerts.body).slice(0, 200));

  const missing = await ask(owner, { message: "crea un empleado" });
  check("orden incompleta pide los datos que faltan", missing.status === 200 && !missing.body.proposal && /falta/.test(String(missing.body.reply)), String(missing.body.reply));

  const proposal = await ask(owner, { message: "crea un vendedor llamado Ana Prueba en Santiago usuario qa_asistente" });
  const p = proposal.body.proposal as { action: string; params: Record<string, unknown>; summary: string[] } | undefined;
  check("propone crear vendedor en la sucursal Santiago", p?.action === "create_employee" && p.params.roleCode === "seller" && p.params.username === "qa_asistente" && /Santiago/.test(p.summary.join(" ")), JSON.stringify(proposal.body).slice(0, 300));

  const notCreatedYet = await db.query(`SELECT 1 FROM farmacia.users WHERE username = 'qa_asistente'`);
  check("no ejecuta nada sin confirmación", notCreatedYet.rows.length === 0);

  const sellerExec = await ask(seller, { execute: p });
  check("vendedor no puede ejecutar la propuesta -> 403", sellerExec.status === 403, String(sellerExec.status));

  const created = await ask(owner, { execute: p });
  check("al confirmar crea el empleado con contraseña temporal", created.status === 200 && String(created.body.temporaryPassword ?? "").length >= 12, JSON.stringify(created.body).slice(0, 200));
  const row = await db.query<{ must_change_password: boolean; branch: string }>(
    `SELECT u.must_change_password, b.name AS branch FROM farmacia.users u JOIN farmacia.user_roles ur ON ur.user_id = u.id
     JOIN farmacia.branches b ON b.id = ur.branch_id WHERE u.username = 'qa_asistente'`);
  check("empleado guardado en PostgreSQL con cambio obligatorio y sucursal correcta", row.rows[0]?.must_change_password === true && /Santiago/.test(row.rows[0]?.branch ?? ""), JSON.stringify(row.rows));

  const duplicate = await ask(owner, { execute: p });
  check("repetir la creación no duplica -> 409", duplicate.status === 409, String(duplicate.status));

  const deact = await ask(owner, { message: "desactiva al usuario qa_asistente" });
  const dp = deact.body.proposal as { action: string; params: Record<string, unknown> } | undefined;
  const deactDone = await ask(owner, { execute: dp });
  const inactive = await db.query<{ is_active: boolean }>(`SELECT is_active FROM farmacia.users WHERE username = 'qa_asistente'`);
  check("desactivar empleado por orden", dp?.action === "deactivate_employee" && deactDone.status === 200 && inactive.rows[0]?.is_active === false, JSON.stringify(deactDone.body));

  const product = await ask(owner, { message: "agrega el medicamento Amoxil forma cápsula concentración 500 mg presentación caja x 21 unidad caja marca GSK" });
  const pp = product.body.proposal as { action: string; params: Record<string, unknown> } | undefined;
  check("interpreta medicamento con todos sus campos", pp?.action === "create_product" && pp.params.productName === "AMOXIL" && pp.params.strength === "500 mg" && pp.params.saleUnit === "caja" && pp.params.brandName === "GSK" && pp.params.dosageForm === "capsula", JSON.stringify(pp?.params));

  const price = await ask(owner, { message: "pon el precio de qa prueba venta a 125.50 en Santiago" });
  const prp = price.body.proposal as { action: string; params: Record<string, unknown>; summary: string[] } | undefined;
  check("interpreta precio con producto, monto y sucursal", prp?.action === "set_price" && prp.params.salePrice === 125.5 && /Santiago/.test(prp.summary.join(" ")), JSON.stringify(price.body).slice(0, 300));

  const setting = await ask(owner, { message: "cambia el pie del comprobante a Gracias por preferirnos" });
  const sp = setting.body.proposal as { action: string; params: Record<string, unknown> } | undefined;
  check("interpreta cambio de configuración", sp?.action === "update_setting" && sp.params.key === "receipt_footer" && sp.params.value === "Gracias por preferirnos", JSON.stringify(sp));

  const unknown = await ask(owner, { message: "baila salsa" });
  check("orden desconocida muestra ayuda sin ejecutar", unknown.status === 200 && !unknown.body.proposal && Array.isArray(unknown.body.bullets));

  const audit = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM farmacia.audit_logs WHERE new_values->>'via' = 'asistente_dueno' AND created_at > NOW() - interval '10 minutes'`);
  check("acciones del asistente quedan auditadas", audit.rows[0].n >= 2, String(audit.rows[0].n));

  await db.end();
  console.log(`\nAsistente: ${passed} aprobadas, ${failed} fallidas`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
