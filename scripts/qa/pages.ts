/**
 * Revisión de páginas por rol (renderizado del servidor).
 *   npx tsx scripts/qa/pages.ts
 * Comprueba que cada página cargue para quien tiene permiso y redirija a quien no lo tiene.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const BASE = "http://localhost:3100";

const data = JSON.parse(readFileSync(join(ROOT, "backups", "qa-accounts.json"), "utf8")) as {
  accounts: { username: string; password: string }[];
};
const passwords = new Map(data.accounts.map((account) => [account.username, account.password]));

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = "") {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${!ok && detail ? ` | ${detail}` : ""}`);
}

async function cookieFor(username: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: passwords.get(username) }),
  });
  if (response.status !== 200) throw new Error(`login ${username}: ${response.status}`);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

async function page(cookie: string | null, path: string) {
  const response = await fetch(BASE + path, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
  const html = response.status === 200 ? await response.text() : "";
  return { status: response.status, location: response.headers.get("location") ?? "", html };
}

/** Redirección por código HTTP o por instrucción en el flujo (streaming de Next.js). */
function redirectsTo(result: { status: number; location: string; html: string }, target: string): boolean {
  return (result.status === 307 && result.location.includes(target)) || result.html.includes(`NEXT_REDIRECT;replace;${target};`);
}

const PAGES = [
  "/dashboard", "/pos", "/ventas", "/clientes", "/purchases", "/suppliers", "/inventory",
  "/transferencias", "/catalogo", "/reportes", "/users", "/auditoria", "/configuracion", "/cambiar-contrasena",
];

const REPORTS = ["sales-by-period", "sales-by-branch", "top-products", "profitability", "purchases", "stock-levels", "expiring", "movements", "branch-performance"];

async function main() {
  const anonymous = await page(null, "/dashboard");
  check("sin sesión: /dashboard redirige a /login sin mostrar contenido", redirectsTo(anonymous, "/login") && !anonymous.html.includes("Bienvenido"), `${anonymous.status}`);

  const publicAssistant = await page(null, "/asistente");
  check("asistente público carga sin sesión", publicAssistant.status === 200 && publicAssistant.html.includes("Asistente Vitalis"));

  const owner = await cookieFor("qa_owner");
  for (const path of PAGES) {
    const result = await page(owner, path);
    const broken = /Application error|Internal Server Error|Unhandled Runtime Error/i.test(result.html);
    check(`propietario: ${path} carga`, result.status === 200 && !broken, `${result.status} ${result.location}`);
  }

  for (const report of REPORTS) {
    const result = await page(owner, `/reportes?report=${report}`);
    check(`propietario: reporte ${report} se muestra`, result.status === 200 && !/Application error/i.test(result.html), String(result.status));
  }

  const seller = await cookieFor("qa_seller_b1");
  const sellerAllowed = ["/dashboard", "/pos", "/ventas", "/clientes", "/inventory", "/catalogo"];
  const sellerDenied = ["/purchases", "/suppliers", "/transferencias", "/reportes", "/users", "/auditoria", "/configuracion"];
  for (const path of sellerAllowed) {
    const result = await page(seller, path);
    check(`vendedor: ${path} permitido`, result.status === 200, `${result.status} ${result.location}`);
  }
  const deniedMarkers: Record<string, string> = {
    "/auditoria": "Registro de operaciones sensibles",
    "/configuracion": "Textos que aparecen en comprobantes",
    "/reportes": "Datos calculados en PostgreSQL",
    "/transferencias": "Solicitud → aprobación",
  };
  for (const path of sellerDenied) {
    const result = await page(seller, path);
    if (deniedMarkers[path]) {
      check(`vendedor: ${path} no expone contenido`, !result.html.includes(deniedMarkers[path]));
    }
    check(`vendedor: ${path} redirige al panel`, redirectsTo(result, "/dashboard"), `${result.status} ${result.location}`);
  }

  const sellerDashboard = await page(seller, "/dashboard");
  check("vendedor: menú no muestra módulos sin permiso", !sellerDashboard.html.includes('href="/configuracion"') && !sellerDashboard.html.includes('href="/auditoria"'));

  const sellerB2 = await cookieFor("qa_seller_b2");
  const b2Dashboard = await page(sellerB2, "/dashboard");
  check("vendedor sucursal 2: panel solo muestra su sucursal", b2Dashboard.html.includes("QA Sucursal 2") && !b2Dashboard.html.includes("Villa Mella"));

  console.log(`\nPáginas aprobadas: ${passed}\nPáginas fallidas: ${failed}`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
