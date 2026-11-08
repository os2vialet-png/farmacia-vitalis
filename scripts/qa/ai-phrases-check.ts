/**
 * Prueba de frases libres con la IA local (Ollama) a través del asistente del dueño.
 * Requiere servidor en :3100 con OLLAMA_MODEL configurado y `npm run qa:setup`.
 * Solo interpreta (no confirma ni ejecuta nada).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const BASE = "http://localhost:3100";
const accounts = new Map(
  (JSON.parse(readFileSync(join(ROOT, "backups", "qa-accounts.json"), "utf8")).accounts as { username: string; password: string }[])
    .map((a) => [a.username, a.password]),
);

const CASES: { phrase: string; expect: (body: Record<string, unknown>) => boolean }[] = [
  { phrase: "oye, ¿qué productos tengo que pedir porque se están acabando?", expect: (b) => /reponer|agotados|mínimo/i.test(String(b.reply)) },
  { phrase: "¿se me va a dañar algo pronto por la fecha?", expect: (b) => /vencer|vence|60 días/i.test(String(b.reply)) },
  { phrase: "¿cómo nos ha ido vendiendo estos últimos días?", expect: (b) => /Ventas/i.test(String(b.reply)) },
  { phrase: "contrata a Pedro Martínez como cajero para la sucursal de Santiago", expect: (b) => (b.proposal as { action?: string } | undefined)?.action === "create_employee" },
  { phrase: "quiero que la caja del qa prueba venta cueste 140 en villa mella", expect: (b) => (b.proposal as { action?: string } | undefined)?.action === "set_price" },
  { phrase: "me equivoqué, devuelve lo último que hiciste", expect: (b) => Boolean(b.proposal) || /deshacer/i.test(String(b.reply)) },
];

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "qa_owner", password: accounts.get("qa_owner") }),
  });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  let passed = 0;
  for (const test of CASES) {
    const started = Date.now();
    const response = await fetch(`${BASE}/api/owner-assistant`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ message: test.phrase }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    const ok = response.status === 200 && test.expect(body);
    if (ok) passed++;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`${ok ? "PASS" : "FAIL"} | «${test.phrase}» → ${body.understoodAs ? `«${String(body.understoodAs)}»` : "(reglas)"} | ${seconds}s`);
  }
  console.log(`\nIA: ${passed}/${CASES.length}`);
  process.exitCode = passed === CASES.length ? 0 : 1;
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
