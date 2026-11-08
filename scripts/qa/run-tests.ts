/**
 * Pruebas de integración contra el servidor en ejecución (http://localhost:3100).
 *
 *   npx tsx scripts/qa/setup.ts          # datos de prueba
 *   npx next start -p 3100               # servidor de producción
 *   npx tsx scripts/qa/run-tests.ts      # ejecuta las pruebas
 *
 * Las pruebas usan cuentas y productos marcados QA. Verifican API, permisos, aislamiento,
 * concurrencia, invariantes de inventario y auditoría. No imprimen contraseñas.
 */
import { createHmac } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { hashPassword } from "../../src/lib/auth/password";

const ROOT = resolve(__dirname, "..", "..");
const BASE = "http://localhost:3100";
const WHATSAPP_SECRET = "qa-test-secret";

type Body = { [key: string]: unknown };
type Result = { status: number; body: Body };

const data = JSON.parse(readFileSync(join(ROOT, "backups", "qa-accounts.json"), "utf8")) as {
  branches: { b1: string; b2: string };
  products: Record<string, string>;
  accounts: { username: string; password: string }[];
};

const accounts = new Map(data.accounts.map((account) => [account.username, account.password]));
const B1 = data.branches.b1;
const B2 = data.branches.b2;
const P = data.products;
const NEWBIE = data.accounts.find((account) => account.username.startsWith("qa_newbie"))?.username ?? "qa_newbie";

function databaseUrl(): string {
  const match = readFileSync(join(ROOT, ".env.local"), "utf8").match(/^DATABASE_URL=(.*)$/m);
  if (!match) throw new Error("Falta DATABASE_URL.");
  return match[1].trim().replace(/^"|"$/g, "");
}

const db = new Client({ connectionString: databaseUrl() });

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`PASS | ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`FAIL | ${name}${detail ? ` | ${detail}` : ""}`);
  }
}

const cookies = new Map<string, string>();
const ipCounter = { n: 1 };

async function login(username: string, password: string, ip?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (ip) headers["x-forwarded-for"] = ip;
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ username, password }),
  });
  const body = (await response.json().catch(() => ({}))) as Body;
  const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0];
  return { status: response.status, body, cookie };
}

async function sessionFor(username: string): Promise<string> {
  const cached = cookies.get(username);
  if (cached) return cached;
  const password = accounts.get(username);
  if (!password) throw new Error(`Cuenta QA desconocida: ${username}`);
  const result = await login(username, password);
  if (result.status !== 200) throw new Error(`No se pudo iniciar sesión con ${username} (${result.status}).`);
  cookies.set(username, result.cookie);
  return result.cookie;
}

async function api(user: string | null, method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Result> {
  const headers: Record<string, string> = { ...extraHeaders };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (user) headers.Cookie = await sessionFor(user);
  const response = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Body;
  return { status: response.status, body: json };
}

function str(body: Body, key: string): string {
  const value = body[key];
  return typeof value === "string" ? value : "";
}

function obj(body: Body, key: string): Body {
  const value = body[key];
  return value && typeof value === "object" ? (value as Body) : {};
}

function arr(body: Body, key: string): Body[] {
  const value = body[key];
  return Array.isArray(value) ? (value as Body[]) : [];
}

function todayInDr(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santo_Domingo" }).format(new Date());
}

async function supplierId(): Promise<string> {
  const result = await db.query<{ id: string }>(`SELECT id FROM farmacia.suppliers WHERE is_active = TRUE LIMIT 1`);
  return result.rows[0].id;
}

/** Compra completa: orden, aprobación y recepción en un lote. Usa solo API. */
async function buyAndReceive(branchId: string, productId: string, quantity: number, cost: number, lot: string, supplier: string) {
  const created = await api("qa_owner", "POST", "/api/purchases", {
    branchId, supplierId: supplier, taxAmount: 0, notes: "QA", items: [{ productId, quantity, unitCost: cost }],
  });
  const orderId = str(obj(created.body, "order"), "id");
  if (created.status !== 201 || !orderId) throw new Error(`Compra QA no creada: ${created.status}`);
  const approved = await api("qa_owner", "PATCH", `/api/purchases/${orderId}`, { action: "order" });
  if (approved.status !== 200) throw new Error(`Compra QA no aprobada: ${approved.status}`);
  const detail = await api("qa_owner", "GET", `/api/purchases/${orderId}`);
  const itemId = str(arr(detail.body, "items")[0] ?? {}, "id");
  const received = await api("qa_owner", "POST", `/api/purchases/${orderId}/receipts`, {
    items: [{ purchaseOrderItemId: itemId, quantityReceived: quantity, lotNumber: lot, expirationDate: "2028-12-31", unitCost: cost }],
  });
  if (received.status !== 200) throw new Error(`Recepción QA fallida: ${received.status} ${str(received.body, "error")}`);
}

async function stockOf(branchId: string, productId: string): Promise<number> {
  const result = await db.query<{ q: string }>(
    `SELECT COALESCE((SELECT quantity_on_hand FROM farmacia.inventory_stock WHERE branch_id = $1 AND product_id = $2), 0)::text AS q`,
    [branchId, productId],
  );
  return Number(result.rows[0].q);
}

async function run() {
  await db.connect();
  const today = todayInDr();

  console.log("=== PREPARACIÓN (solo API) ===");

  // Verificación y datos comerciales del producto de venta.
  const verifyWithoutEvidence = await api("qa_pharm_b1", "POST", `/api/catalog/${P.p1}/verify`, {
    status: "verified", evidenceType: "sanitary_registry", evidenceReference: "QA-NO-EXISTE-0000",
  });
  check("verificación con registro inexistente -> 409", verifyWithoutEvidence.status === 409, `status ${verifyWithoutEvidence.status}`);

  const shortNotes = await api("qa_pharm_b1", "POST", `/api/catalog/${P.p1}/verify`, {
    status: "verified", evidenceType: "manual_review", evidenceReference: "QA-ACTA-1", notes: "corto",
  });
  check("verificación manual sin justificación suficiente -> 400", shortNotes.status === 400, `status ${shortNotes.status}`);

  const verified = await api("qa_pharm_b1", "POST", `/api/catalog/${P.p1}/verify`, {
    status: "verified", evidenceType: "manual_review", evidenceReference: "QA-ACTA-1",
    notes: "Producto de prueba QA sin registro sanitario; verificación manual para validar el flujo de venta.",
  });
  check("farmacéutico verifica producto QA con justificación -> 201", verified.status === 201, `status ${verified.status}`);

  const sellerVerify = await api("qa_seller_b1", "POST", `/api/catalog/${P.p1}/verify`, {
    status: "verified", evidenceType: "manual_review", evidenceReference: "QA-ACTA-2",
    notes: "Intento de verificación por vendedor, debe fallar por permisos.",
  });
  check("vendedor no puede verificar -> 403", sellerVerify.status === 403, `status ${sellerVerify.status}`);

  const configured = await api("qa_admin_b1", "PATCH", `/api/catalog/${P.p1}`, {
    saleUnit: "tableta", taxPercent: 18, presentation: "Caja x 10 tabletas",
  });
  check("administrador configura unidad de venta e impuesto -> 200", configured.status === 200, `status ${configured.status}`);

  const sellerEdit = await api("qa_seller_b1", "PATCH", `/api/catalog/${P.p1}`, { brandName: "QA" });
  check("vendedor no puede editar catálogo -> 403", sellerEdit.status === 403, `status ${sellerEdit.status}`);

  const priceB1 = await api("qa_owner", "POST", `/api/catalog/${P.p1}/prices`, { branchId: B1, salePrice: 100 });
  const priceB2 = await api("qa_owner", "POST", `/api/catalog/${P.p1}/prices`, { branchId: B2, salePrice: 120 });
  check("propietario fija precio en sucursal 1 -> 201", priceB1.status === 201, `status ${priceB1.status}`);
  check("propietario fija precio en sucursal 2 -> 201", priceB2.status === 201, `status ${priceB2.status}`);

  const badPrice = await api("qa_owner", "POST", `/api/catalog/${P.p1}/prices`, { branchId: B1, salePrice: -5 });
  check("precio negativo -> 400", badPrice.status === 400, `status ${badPrice.status}`);

  const supplier = await supplierId();
  await buyAndReceive(B1, P.p1, 20, 50, "QA-POS-1", supplier);
  await buyAndReceive(B1, P.p2, 30, 30, "QA-TR-1", supplier);
  await buyAndReceive(B1, P.p3, 5, 10, "QA-NV-1", supplier);
  check("compras QA recibidas en sucursal 1", (await stockOf(B1, P.p1)) >= 20, "stock insuficiente en preparación");

  // -------------------------------------------------------------------------------
  console.log("\n=== A. AUTENTICACIÓN Y CONTRASEÑAS ===");

  const anonymous = await api(null, "GET", "/api/purchases");
  check("sin sesión -> 401", anonymous.status === 401, `status ${anonymous.status}`);

  // Usuario inexistente e IP única por ejecución: la prueba es repetible y no bloquea cuentas QA.
  const runIp = `203.0.113.${(Date.now() % 200) + 20}`;
  const wrong = await login(`qa_wrong_${Date.now()}`, "clave-incorrecta-99", "198.18.0.9");
  check("credenciales incorrectas -> 401", wrong.status === 401, `status ${wrong.status}`);

  const throttleUser = `qa_throttle_${Date.now()}`;
  const throttle: number[] = [];
  for (let i = 0; i < 6; i++) {
    throttle.push((await login(throttleUser, "clave-incorrecta-99", runIp)).status);
  }
  check("límite por usuario e IP: 5 intentos y luego 429", JSON.stringify(throttle) === JSON.stringify([401, 401, 401, 401, 401, 429]), throttle.join(","));

  const newbie = await login(NEWBIE, accounts.get(NEWBIE) ?? "");
  check("contraseña temporal -> redirige a cambio obligatorio", newbie.body.redirectTo === "/cambiar-contrasena" && newbie.body.mustChangePassword === true, JSON.stringify(newbie.body));
  const newbieCookie = newbie.cookie;

  const newbieBlocked = await fetch(`${BASE}/api/purchases?branchId=${B1}`, { headers: { Cookie: newbieCookie } });
  check("contraseña temporal bloquea módulos (GET compras) -> 403", newbieBlocked.status === 403, `status ${newbieBlocked.status}`);

  const newbieSale = await fetch(`${BASE}/api/sales`, {
    method: "POST",
    headers: { Cookie: newbieCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ branchId: B1, idempotencyKey: "qa-newbie-key-1", items: [{ productId: P.p1, quantity: 1 }], payments: [{ method: "cash", amount: 200 }] }),
  });
  check("contraseña temporal no puede vender -> 403", newbieSale.status === 403, `status ${newbieSale.status}`);

  const newbieWrongCurrent = await fetch(`${BASE}/api/auth/change-password`, {
    method: "POST", headers: { Cookie: newbieCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: "nada-de-esto-1", newPassword: "Nueva-clave-QA-2026", confirmPassword: "Nueva-clave-QA-2026" }),
  });
  check("cambio con contraseña actual incorrecta -> 400", newbieWrongCurrent.status === 400, `status ${newbieWrongCurrent.status}`);

  const weakPolicy = await fetch(`${BASE}/api/auth/change-password`, {
    method: "POST", headers: { Cookie: newbieCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: accounts.get(NEWBIE), newPassword: "password1234", confirmPassword: "password1234" }),
  });
  check("política: contraseña común rechazada -> 400", weakPolicy.status === 400, `status ${weakPolicy.status}`);

  const usernameInPassword = await fetch(`${BASE}/api/auth/change-password`, {
    method: "POST", headers: { Cookie: newbieCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: accounts.get(NEWBIE), newPassword: `${NEWBIE.toUpperCase()}-clave-2026`, confirmPassword: `${NEWBIE.toUpperCase()}-clave-2026` }),
  });
  check("política: no puede contener el usuario -> 400", usernameInPassword.status === 400, `status ${usernameInPassword.status}`);

  const newNewbiePassword = `Clave-nueva-QA-${ipCounter.n}-ok`;
  const changed = await fetch(`${BASE}/api/auth/change-password`, {
    method: "POST", headers: { Cookie: newbieCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: accounts.get(NEWBIE), newPassword: newNewbiePassword, confirmPassword: newNewbiePassword }),
  });
  check("cambio de contraseña válido -> 200", changed.status === 200, `status ${changed.status}`);
  accounts.set(NEWBIE, newNewbiePassword);

  const oldSession = await fetch(`${BASE}/api/purchases?branchId=${B1}`, { headers: { Cookie: newbieCookie } });
  check("sesión anterior revocada tras el cambio -> 401", oldSession.status === 401, `status ${oldSession.status}`);

  const newbieAgain = await login(NEWBIE, newNewbiePassword);
  check("nueva contraseña inicia sesión y va al panel", newbieAgain.status === 200 && newbieAgain.body.redirectTo === "/dashboard", JSON.stringify(newbieAgain.body));

  // Restablecimiento del propietario desde consola (procedimiento real del script).
  const resetOutput = execSync("npx tsx scripts/reset-owner-password.ts qa_norole", {
    cwd: ROOT,
    input: "RESTABLECER\n",
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl() },
  });
  const lines = resetOutput.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.includes("CONTRASEÑA TEMPORAL"));
  const temporary = lines[headerIndex + 1]?.trim() ?? "";
  check("restablecimiento por consola genera contraseña temporal", headerIndex >= 0 && temporary.length >= 12, "no se encontró contraseña");

  const resetLogin = await login("qa_norole", temporary);
  check("contraseña restablecida obliga a cambiarla", resetLogin.body.redirectTo === "/cambiar-contrasena", JSON.stringify(resetLogin.body));
  const resetNew = `Restablecida-QA-${ipCounter.n}-ok`;
  const resetChange = await fetch(`${BASE}/api/auth/change-password`, {
    method: "POST", headers: { Cookie: resetLogin.cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword: temporary, newPassword: resetNew, confirmPassword: resetNew }),
  });
  check("tras restablecer, el cambio de contraseña funciona", resetChange.status === 200, `status ${resetChange.status}`);
  accounts.set("qa_norole", resetNew);

  // -------------------------------------------------------------------------------
  console.log("\n=== B. PERMISOS POR ROL ===");

  const normalSeller = await api("qa_seller_b1", "GET", `/api/sales?branchId=${B1}`);
  check("vendedor puede ver ventas de su sucursal -> 200", normalSeller.status === 200, `status ${normalSeller.status}`);

  const sellerCancel = await api("qa_seller_b1", "POST", `/api/sales/00000000-0000-4000-8000-000000000000/cancel`, { reason: "Motivo de prueba QA" });
  check("vendedor no puede anular ventas -> 403", sellerCancel.status === 403, `status ${sellerCancel.status}`);

  const pharmacistApprove = await api("qa_pharm_b1", "POST", `/api/transfers/00000000-0000-4000-8000-000000000000/approve`, { items: [] });
  check("farmacéutico no puede aprobar transferencias -> 403", pharmacistApprove.status === 403, `status ${pharmacistApprove.status}`);

  const invCannotSell = await api("qa_inv_b1", "POST", "/api/sales", {
    branchId: B1, idempotencyKey: "qa-inv-key-0001", items: [{ productId: P.p1, quantity: 1 }], payments: [{ method: "cash", amount: 200 }],
  });
  check("encargado de inventario no puede vender -> 403", invCannotSell.status === 403, `status ${invCannotSell.status}`);

  const noRoleSales = await api("qa_norole", "GET", `/api/sales?branchId=${B1}`);
  check("usuario sin roles no ve ventas -> 403", noRoleSales.status === 403, `status ${noRoleSales.status}`);

  // -------------------------------------------------------------------------------
  console.log("\n=== C. AISLAMIENTO ENTRE SUCURSALES ===");

  const crossSales = await api("qa_seller_b2", "GET", `/api/sales?branchId=${B1}`);
  check("vendedor de sucursal 2 no ve ventas de sucursal 1 -> 403", crossSales.status === 403, `status ${crossSales.status}`);

  const crossProducts = await api("qa_seller_b2", "GET", `/api/pos/products?branchId=${B1}&q=QA%20PRUEBA`);
  check("vendedor de sucursal 2 no busca para sucursal 1 -> 403", crossProducts.status === 403, `status ${crossProducts.status}`);

  const crossInventory = await api("qa_seller_b2", "GET", `/api/inventory?branchId=${B1}`);
  check("inventario de sucursal 1 no visible desde sucursal 2 -> 403", crossInventory.status === 403, `status ${crossInventory.status}`);

  const crossReport = await api("qa_seller_b2", "GET", `/api/reports?report=sales-by-period&branchId=${B1}&from=${today}&to=${today}`);
  check("reportes de sucursal 1 no accesibles para vendedor de sucursal 2 -> 403", crossReport.status === 403, `status ${crossReport.status}`);

  const adminCrossPurchases = await api("qa_admin_b1", "GET", `/api/purchases?branchId=${B2}`);
  check("administrador de sucursal 1 no ve compras de sucursal 2 -> 403", adminCrossPurchases.status === 403, `status ${adminCrossPurchases.status}`);

  const crossTransferList = await api("qa_seller_b2", "GET", `/api/transfers?branchId=${B1}`);
  check("transferencias de sucursal 1 no visibles desde sucursal 2 -> 403", crossTransferList.status === 403, `status ${crossTransferList.status}`);

  // -------------------------------------------------------------------------------
  console.log("\n=== D. PUNTO DE VENTA ===");

  const initialStock = await stockOf(B1, P.p1);
  const search = await api("qa_seller_b1", "GET", `/api/pos/products?branchId=${B1}&q=prueba%20venta`);
  const found = arr(search.body, "products").find((item) => item.id === P.p1);
  check("búsqueda POS encuentra producto verificado con disponibilidad", Boolean(found) && Number(found?.available) === initialStock, JSON.stringify(found ?? {}));

  const unverifiedSearch = await api("qa_seller_b1", "GET", `/api/pos/products?branchId=${B1}&q=NO%20VERIFICADO`);
  check("búsqueda POS no muestra productos no verificados", arr(unverifiedSearch.body, "products").length === 0, `${arr(unverifiedSearch.body, "products").length} resultados`);

  const K1 = `qa-sale-${Date.now()}-A`;
  const sale1 = await api("qa_seller_b1", "POST", "/api/sales", {
    branchId: B1, idempotencyKey: K1, items: [{ productId: P.p1, quantity: 5 }], payments: [{ method: "cash", amount: 600 }], notes: "Venta de prueba QA",
  });
  const sale1Body = obj(sale1.body, "sale");
  check("venta de 5 unidades confirmada -> 201", sale1.status === 201, `status ${sale1.status} ${str(sale1.body, "error")}`);
  check("total con impuesto incluido: RD$500.00 y cambio RD$100.00", str(sale1Body, "total") === "500.00" && str(sale1Body, "change_amount") === "100.00", `total ${str(sale1Body, "total")} cambio ${str(sale1Body, "change_amount")}`);
  check("inventario descontado en 5 unidades", (await stockOf(B1, P.p1)) === initialStock - 5, `antes ${initialStock} ahora ${await stockOf(B1, P.p1)}`);

  const sale1Id = str(sale1Body, "id");
  const duplicate = await api("qa_seller_b1", "POST", "/api/sales", {
    branchId: B1, idempotencyKey: K1, items: [{ productId: P.p1, quantity: 5 }], payments: [{ method: "cash", amount: 600 }],
  });
  check("mismo idempotencyKey no duplica la venta", duplicate.status === 200 && duplicate.body.duplicate === true && str(obj(duplicate.body, "sale"), "id") === sale1Id, `status ${duplicate.status}`);
  check("reintento no descuenta inventario otra vez", (await stockOf(B1, P.p1)) === initialStock - 5, `stock ${await stockOf(B1, P.p1)}`);

  const oversell = await api("qa_seller_b1", "POST", "/api/sales", {
    branchId: B1, idempotencyKey: `qa-oversell-${Date.now()}`, items: [{ productId: P.p1, quantity: initialStock - 4 }], payments: [{ method: "cash", amount: 100000 }],
  });
  check("inventario insuficiente -> 409 y sin descuento", oversell.status === 409 && (await stockOf(B1, P.p1)) === initialStock - 5, `status ${oversell.status}`);

  const unverifiedSale = await api("qa_seller_b1", "POST", "/api/sales", {
    branchId: B1, idempotencyKey: "qa-sale-unverified-1", items: [{ productId: P.p3, quantity: 1 }], payments: [{ method: "cash", amount: 500 }],
  });
  check("producto no verificado no se vende -> 409", unverifiedSale.status === 409, `status ${unverifiedSale.status}`);

  const inactiveSale = await api("qa_seller_b1", "POST", "/api/sales", {
    branchId: B1, idempotencyKey: "qa-sale-inactive-1", items: [{ productId: P.inactive, quantity: 1 }], payments: [{ method: "cash", amount: 500 }],
  });
  check("producto inactivo no se vende -> 409", inactiveSale.status === 409, `status ${inactiveSale.status}`);

  const sellerDiscount = await api("qa_seller_b1", "POST", "/api/sales", {
    branchId: B1, idempotencyKey: "qa-sale-discount-s1", items: [{ productId: P.p1, quantity: 1, discount: 10, discountReason: "Prueba" }], payments: [{ method: "cash", amount: 200 }],
  });
  check("descuento sin permiso -> 403", sellerDiscount.status === 403, `status ${sellerDiscount.status}`);

  const runDoc = `QA-${Date.now()}`;
  const customerCreate = await api("qa_seller_b1", "POST", "/api/customers", {
    fullName: "Cliente QA Venta", phone: "809-555-0101", documentNumber: runDoc, privacyAccepted: true,
    commercialConsents: [{ type: "commercial_whatsapp", granted: true }],
  });
  const customerId = str(customerCreate.body, "id");
  check("cliente QA registrado para venta -> 201", customerCreate.status === 201 && customerId.length > 0, `status ${customerCreate.status}`);

  const adminDiscountSale = await api("qa_admin_b1", "POST", "/api/sales", {
    branchId: B1, idempotencyKey: `qa-admin-disc-${Date.now()}`, customerId,
    items: [{ productId: P.p1, quantity: 1, discount: 10, discountReason: "Descuento QA" }],
    payments: [{ method: "card", amount: 90, reference: "QA-REF-1" }],
  });
  const adminSaleId = str(obj(adminDiscountSale.body, "sale"), "id");
  check("administrador aplica descuento con motivo -> 201 y total 90", adminDiscountSale.status === 201 && str(obj(adminDiscountSale.body, "sale"), "total") === "90.00", `status ${adminDiscountSale.status} ${str(adminDiscountSale.body, "error")}`);

  const underpaid = await api("qa_seller_b1", "POST", "/api/sales", {
    branchId: B1, idempotencyKey: "qa-sale-underpaid1", items: [{ productId: P.p1, quantity: 1 }], payments: [{ method: "cash", amount: 50 }],
  });
  check("pago insuficiente -> 400", underpaid.status === 400, `status ${underpaid.status}`);

  const changeWithoutCash = await api("qa_seller_b1", "POST", "/api/sales", {
    branchId: B1, idempotencyKey: "qa-sale-nocash-01", items: [{ productId: P.p1, quantity: 1 }], payments: [{ method: "card", amount: 200 }],
  });
  check("cambio solo en efectivo: tarjeta excedente -> 400", changeWithoutCash.status === 400, `status ${changeWithoutCash.status}`);

  const otherBranchSale = await api("qa_owner", "POST", "/api/sales", {
    branchId: B2, idempotencyKey: "qa-sale-branch2-01", items: [{ productId: P.p1, quantity: 1 }], payments: [{ method: "cash", amount: 500 }],
  });
  check("sin stock en sucursal 2 -> 409", otherBranchSale.status === 409, `status ${otherBranchSale.status}`);

  // Concurrencia: 10 ventas simultáneas de 2 unidades sobre el inventario disponible.
  const before = await stockOf(B1, P.p1);
  const parallel = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      api("qa_owner", "POST", "/api/sales", {
        branchId: B1, idempotencyKey: `qa-parallel-${Date.now()}-${i}`, items: [{ productId: P.p1, quantity: 2 }], payments: [{ method: "cash", amount: 1000 }],
      }),
    ),
  );
  const accepted = parallel.filter((response) => response.status === 201).length;
  const rejected = parallel.filter((response) => response.status === 409).length;
  const after = await stockOf(B1, P.p1);
  // Con inventario de sobra se aceptan las 10; solo cuando alcanza para menos de 10 se rechazan las del final.
  const expectedAccepted = Math.min(10, Math.floor(before / 2));
  check("concurrencia: sin sobreventa (aceptadas = las que alcanzan)", accepted === expectedAccepted && accepted + rejected === 10, `antes ${before}, aceptadas ${accepted}, rechazadas ${rejected}, esperadas ${expectedAccepted}`);
  check("concurrencia: inventario nunca negativo y consistente", after === before - accepted * 2 && after >= 0, `antes ${before} después ${after}`);

  const sellerCancelSale = await api("qa_seller_b1", "POST", `/api/sales/${sale1Id}/cancel`, { reason: "Intento de anulación QA" });
  check("vendedor no puede anular venta -> 403", sellerCancelSale.status === 403, `status ${sellerCancelSale.status}`);

  const beforeCancel = await stockOf(B1, P.p1);
  const cancel = await api("qa_admin_b1", "POST", `/api/sales/${sale1Id}/cancel`, { reason: "Anulación de prueba QA" });
  check("administrador anula venta -> 200", cancel.status === 200, `status ${cancel.status} ${str(cancel.body, "error")}`);
  check("anulación repone exactamente 5 unidades", (await stockOf(B1, P.p1)) === beforeCancel + 5, `antes ${beforeCancel}`);
  const cancelAgain = await api("qa_admin_b1", "POST", `/api/sales/${sale1Id}/cancel`, { reason: "Segunda anulación QA" });
  check("segunda anulación de la misma venta -> 409", cancelAgain.status === 409, `status ${cancelAgain.status}`);

  const history = await api("qa_seller_b1", "GET", `/api/sales?branchId=${B1}&status=all`);
  check("historial de ventas accesible en su sucursal", history.status === 200 && arr(history.body, "sales").length > 0, `status ${history.status}`);

  const crossSaleDetail = await api("qa_seller_b2", "GET", `/api/sales/${adminSaleId}`);
  check("detalle de venta de otra sucursal -> 403", crossSaleDetail.status === 403, `status ${crossSaleDetail.status}`);

  // -------------------------------------------------------------------------------
  console.log("\n=== E. CLIENTES Y CONSENTIMIENTOS ===");

  const noPrivacy = await api("qa_seller_b1", "POST", "/api/customers", { fullName: "Sin Aviso QA", privacyAccepted: false });
  check("cliente sin aviso de privacidad -> 400", noPrivacy.status === 400, `status ${noPrivacy.status}`);

  const duplicateDoc = await api("qa_seller_b1", "POST", "/api/customers", { fullName: "Duplicado QA", documentNumber: runDoc, privacyAccepted: true });
  check("documento duplicado -> 409", duplicateDoc.status === 409, `status ${duplicateDoc.status}`);

  const revokePrivacy = await api("qa_seller_b1", "POST", `/api/customers/${customerId}/consents`, { consentType: "personal_data_processing", granted: false });
  check("no se puede revocar el tratamiento de datos base -> 400", revokePrivacy.status === 400, `status ${revokePrivacy.status}`);

  const grantEmail = await api("qa_seller_b1", "POST", `/api/customers/${customerId}/consents`, { consentType: "commercial_email", granted: true });
  const revokeWhatsapp = await api("qa_seller_b1", "POST", `/api/customers/${customerId}/consents`, { consentType: "commercial_whatsapp", granted: false });
  check("consentimientos comerciales se registran por separado", grantEmail.status === 201 && revokeWhatsapp.status === 201, `${grantEmail.status}/${revokeWhatsapp.status}`);

  const detail = await api("qa_seller_b1", "GET", `/api/customers/${customerId}`);
  const consents = arr(detail.body, "consents");
  const state = (type: string) => consents.find((item) => item.consent_type === type)?.granted;
  check("estado actual: email autorizado, WhatsApp revocado, datos base autorizados", state("commercial_email") === true && state("commercial_whatsapp") === false && state("personal_data_processing") === true, JSON.stringify(consents));

  const adminCustomerView = await api("qa_admin_b1", "GET", `/api/customers/${customerId}`);
  const customerHistoryOwn = arr(adminCustomerView.body, "purchases");
  check("cliente: admin de sucursal 1 ve la compra en su sucursal", customerHistoryOwn.length >= 1, `compras ${customerHistoryOwn.length}`);

  const customerForB2 = await api("qa_seller_b2", "GET", `/api/customers/${customerId}`);
  check("cliente: vendedor de sucursal 2 no ve compras de sucursal 1", arr(customerForB2.body, "purchases").length === 0, `status ${customerForB2.status}`);

  const piiInAudit = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM farmacia.audit_logs WHERE action = 'customer.create' AND new_values::text ILIKE '%Cliente QA Venta%'`,
  );
  check("auditoría de clientes no guarda nombres", piiInAudit.rows[0].n === 0, `coincidencias ${piiInAudit.rows[0].n}`);

  // -------------------------------------------------------------------------------
  console.log("\n=== F. TRANSFERENCIAS ENTRE SUCURSALES ===");

  const requestByEmployee = await api("qa_seller_b1", "POST", "/api/transfers", {
    originBranchId: B2, destinationBranchId: B1, items: [{ productId: P.p2, quantity: 1 }],
  });
  check("vendedor no puede solicitar transferencias -> 403", requestByEmployee.status === 403, `status ${requestByEmployee.status}`);

  const sameBranch = await api("qa_inv_b1", "POST", "/api/transfers", {
    originBranchId: B1, destinationBranchId: B1, items: [{ productId: P.p2, quantity: 1 }],
  });
  check("origen y destino iguales -> 400", sameBranch.status === 400, `status ${sameBranch.status}`);

  const request1 = await api("qa_inv_b2", "POST", "/api/transfers", {
    originBranchId: B1, destinationBranchId: B2, notes: "Reposición QA", items: [{ productId: P.p2, quantity: 6 }],
  });
  const t1 = str(obj(request1.body, "transfer"), "id");
  check("encargado de sucursal 2 solicita a sucursal 1 -> 201", request1.status === 201 && t1.length > 0, `status ${request1.status} ${str(request1.body, "error")}`);

  const approveByPharm = await api("qa_pharm_b1", "POST", `/api/transfers/${t1}/approve`, { items: [] });
  check("farmacéutico no puede aprobar -> 403", approveByPharm.status === 403, `status ${approveByPharm.status}`);

  const itemsT1 = arr(obj(request1.body, "transfer"), "items");
  const itemT1 = str(itemsT1[0] ?? {}, "id");

  const approve1 = await api("qa_admin_b1", "POST", `/api/transfers/${t1}/approve`, {
    items: [{ itemId: itemT1, quantityApproved: 4 }],
  });
  check("aprobación parcial (4 de 6) -> 200", approve1.status === 200, `status ${approve1.status} ${str(approve1.body, "error")}`);

  const dispatchWrong = await api("qa_inv_b2", "POST", `/api/transfers/${t1}/dispatch`, {});
  check("destino no puede despachar -> 403", dispatchWrong.status === 403, `status ${dispatchWrong.status}`);

  const originBefore = await stockOf(B1, P.p2);
  const dispatch1 = await api("qa_inv_b1", "POST", `/api/transfers/${t1}/dispatch`, {});
  check("origen despacha 4 unidades -> 200", dispatch1.status === 200, `status ${dispatch1.status} ${str(dispatch1.body, "error")}`);
  check("origen descuenta exactamente 4 unidades", (await stockOf(B1, P.p2)) === originBefore - 4, `antes ${originBefore}`);

  const receiveNoReason = await api("qa_inv_b2", "POST", `/api/transfers/${t1}/receive`, {
    items: [{ itemId: itemT1, quantityReceived: 3 }],
  });
  check("diferencia sin motivo -> 400", receiveNoReason.status === 400, `status ${receiveNoReason.status}`);

  const destBefore = await stockOf(B2, P.p2);
  const receive1 = await api("qa_inv_b2", "POST", `/api/transfers/${t1}/receive`, {
    items: [{ itemId: itemT1, quantityReceived: 3, discrepancyReason: "Una caja llegó dañada (QA)" }],
  });
  check("recepción de 3 con motivo de diferencia -> 200", receive1.status === 200, `status ${receive1.status} ${str(receive1.body, "error")}`);
  check("destino recibe exactamente 3 unidades", (await stockOf(B2, P.p2)) === destBefore + 3, `antes ${destBefore}`);

  const receiveAgain = await api("qa_inv_b2", "POST", `/api/transfers/${t1}/receive`, {
    items: [{ itemId: itemT1, quantityReceived: 1 }],
  });
  check("recibir de nuevo la misma transferencia -> 409", receiveAgain.status === 409, `status ${receiveAgain.status}`);

  const cancelReceived = await api("qa_inv_b2", "POST", `/api/transfers/${t1}/cancel`, { reason: "Intento de cancelar recibida" });
  check("no se cancela una transferencia recibida -> 409", cancelReceived.status === 409, `status ${cancelReceived.status}`);

  // Dos despachos simultáneos de la misma transferencia.
  const t2Request = await api("qa_inv_b2", "POST", "/api/transfers", {
    originBranchId: B1, destinationBranchId: B2, items: [{ productId: P.p2, quantity: 3 }],
  });
  const t2 = str(obj(t2Request.body, "transfer"), "id");
  const t2Item = str(arr(obj(t2Request.body, "transfer"), "items")[0] ?? {}, "id");
  await api("qa_admin_b1", "POST", `/api/transfers/${t2}/approve`, { items: [{ itemId: t2Item, quantityApproved: 3 }] });
  const racing = await Promise.all([
    api("qa_inv_b1", "POST", `/api/transfers/${t2}/dispatch`, {}),
    api("qa_inv_b1", "POST", `/api/transfers/${t2}/dispatch`, {}),
  ]);
  const okCount = racing.filter((response) => response.status === 200).length;
  check("dos despachos simultáneos: solo uno ejecuta", okCount === 1, `códigos ${racing.map((r) => r.status).join(",")}`);

  const t3Request = await api("qa_inv_b2", "POST", "/api/transfers", {
    originBranchId: B1, destinationBranchId: B2, items: [{ productId: P.p2, quantity: 2 }],
  });
  const t3 = str(obj(t3Request.body, "transfer"), "id");
  const rejected3 = await api("qa_admin_b1", "POST", `/api/transfers/${t3}/reject`, { reason: "Sin stock disponible (QA)" });
  check("origen rechaza solicitud con motivo -> 200", rejected3.status === 200, `status ${rejected3.status}`);
  const dispatchRejected = await api("qa_inv_b1", "POST", `/api/transfers/${t3}/dispatch`, {});
  check("transferencia rechazada no se despacha -> 409", dispatchRejected.status === 409, `status ${dispatchRejected.status}`);

  const transferList = await api("qa_inv_b2", "GET", `/api/transfers?branchId=${B2}&direction=incoming`);
  check("lista de transferencias entrantes de sucursal 2", transferList.status === 200 && arr(transferList.body, "transfers").length >= 1, `status ${transferList.status}`);

  // -------------------------------------------------------------------------------
  console.log("\n=== F2. CONCILIACIÓN DE DIFERENCIAS ===");

  const pharmacistsReconcile = await api("qa_pharm_b1", "POST", `/api/transfers/${t1}/reconcile`, {
    items: [{ itemId: "00000000-0000-4000-8000-000000000000", resolution: "written_off", reason: "Intento de farmacéutico (QA)" }],
  });
  check("farmacéutico no puede conciliar diferencias -> 403", pharmacistsReconcile.status === 403, `status ${pharmacistsReconcile.status}`);

  // t2 quedó despachada y sin recibir: no se concilia.
  const reconcileUnreceived = await api("qa_owner", "POST", `/api/transfers/${t2}/reconcile`, {
    items: [{ itemId: t2Item, resolution: "written_off", reason: "Conciliación antes de recibir (QA)" }],
  });
  check("transferencia no recibida no se concilia -> 409", reconcileUnreceived.status === 409, `status ${reconcileUnreceived.status}`);

  const b2AfterFirstTransfer = await stockOf(B2, P.p2);

  // t4: llegada tardía en destino.
  const t4Request = await api("qa_inv_b2", "POST", "/api/transfers", {
    originBranchId: B1, destinationBranchId: B2, items: [{ productId: P.p2, quantity: 2 }],
  });
  const t4 = str(obj(t4Request.body, "transfer"), "id");
  const t4Item = str(arr(obj(t4Request.body, "transfer"), "items")[0] ?? {}, "id");
  await api("qa_admin_b1", "POST", `/api/transfers/${t4}/approve`, { items: [{ itemId: t4Item, quantityApproved: 2 }] });
  await api("qa_inv_b1", "POST", `/api/transfers/${t4}/dispatch`, {});
  const receiveT4 = await api("qa_inv_b2", "POST", `/api/transfers/${t4}/receive`, {
    items: [{ itemId: t4Item, quantityReceived: 1, discrepancyReason: "Una unidad se quedó en el almacén de origen (QA)" }],
  });
  check("t4 recibida con diferencia pendiente", receiveT4.status === 200, `status ${receiveT4.status}`);

  const reconcileShortReason = await api("qa_inv_b2", "POST", `/api/transfers/${t4}/reconcile`, {
    items: [{ itemId: t4Item, resolution: "found_late", reason: "corto" }],
  });
  check("conciliación sin motivo suficiente -> 400", reconcileShortReason.status === 400, `status ${reconcileShortReason.status}`);

  const lateArrival = await api("qa_inv_b2", "POST", `/api/transfers/${t4}/reconcile`, {
    items: [{ itemId: t4Item, resolution: "found_late", reason: "La unidad apareció tarde en el almacén destino (QA)" }],
  });
  check("llegada tardía registrada por la sucursal destino -> 200", lateArrival.status === 200, `status ${lateArrival.status} ${str(lateArrival.body, "error")}`);
  check("llegada tardía suma la unidad en destino", (await stockOf(B2, P.p2)) === b2AfterFirstTransfer + 2, `antes ${b2AfterFirstTransfer}, tras recepción y llegada tardía debe sumar 2 (recibida + tardía)`);

  const t4Balance = await db.query<{ dispatched: number; received: number; missing: number; resolution: string | null }>(
    `SELECT quantity_dispatched::int AS dispatched, quantity_received::int AS received,
            quantity_missing::int AS missing, missing_resolution AS resolution
     FROM farmacia.transfer_items WHERE transfer_id = $1`,
    [t4],
  );
  const tb4 = t4Balance.rows[0];
  check("t4 cuadra tras la llegada tardía: despachado = recibido y sin diferencia", tb4.dispatched === 2 && tb4.received === 2 && tb4.missing === 0 && tb4.resolution === "found_late", JSON.stringify(tb4));

  const reconcileTwice = await api("qa_inv_b2", "POST", `/api/transfers/${t4}/reconcile`, {
    items: [{ itemId: t4Item, resolution: "written_off", reason: "Intento repetido de conciliación (QA)" }],
  });
  check("misma línea no se concilia dos veces -> 409", reconcileTwice.status === 409, `status ${reconcileTwice.status}`);

  // t5: la diferencia se da por perdida.
  const t5Request = await api("qa_inv_b2", "POST", "/api/transfers", {
    originBranchId: B1, destinationBranchId: B2, items: [{ productId: P.p2, quantity: 2 }],
  });
  const t5 = str(obj(t5Request.body, "transfer"), "id");
  const t5Item = str(arr(obj(t5Request.body, "transfer"), "items")[0] ?? {}, "id");
  await api("qa_admin_b1", "POST", `/api/transfers/${t5}/approve`, { items: [{ itemId: t5Item, quantityApproved: 2 }] });
  await api("qa_inv_b1", "POST", `/api/transfers/${t5}/dispatch`, {});
  await api("qa_inv_b2", "POST", `/api/transfers/${t5}/receive`, {
    items: [{ itemId: t5Item, quantityReceived: 1, discrepancyReason: "Una unidad no se encontró al recibir (QA)" }],
  });
  const b1BeforeWriteOff = await stockOf(B1, P.p2);
  const writeOff = await api("qa_inv_b2", "POST", `/api/transfers/${t5}/reconcile`, {
    items: [{ itemId: t5Item, resolution: "written_off", reason: "Se da por perdida una unidad no llegadas, lo conversado (QA)" }],
  });
  check("diferencia dada por perdida -> 200", writeOff.status === 200, `status ${writeOff.status} ${str(writeOff.body, "error")}`);
  check("dar por perdida no mueve inventarios", (await stockOf(B1, P.p2)) === b1BeforeWriteOff, `origen ${b1BeforeWriteOff}`);
  const t5Row = (await db.query<{ resolution: string | null; missing: number }>(
    `SELECT missing_resolution AS resolution, quantity_missing::int AS missing
     FROM farmacia.transfer_items WHERE transfer_id = $1`,
    [t5],
  )).rows[0];
  check("t5 marca la resolución written_off con diferencia conservada", t5Row.resolution === "written_off" && t5Row.missing === 1, JSON.stringify(t5Row));

  // t6: devolución de la mercancía al estante de origen.
  const t6Request = await api("qa_inv_b2", "POST", "/api/transfers", {
    originBranchId: B1, destinationBranchId: B2, items: [{ productId: P.p2, quantity: 2 }],
  });
  const t6 = str(obj(t6Request.body, "transfer"), "id");
  const t6Item = str(arr(obj(t6Request.body, "transfer"), "items")[0] ?? {}, "id");
  await api("qa_admin_b1", "POST", `/api/transfers/${t6}/approve`, { items: [{ itemId: t6Item, quantityApproved: 2 }] });
  await api("qa_inv_b1", "POST", `/api/transfers/${t6}/dispatch`, {});
  await api("qa_inv_b2", "POST", `/api/transfers/${t6}/receive`, {
    items: [{ itemId: t6Item, quantityReceived: 1, discrepancyReason: "Una unidad volvió al contenedor de origen (QA)" }],
  });

  const returnWrongBranch = await api("qa_inv_b2", "POST", `/api/transfers/${t6}/reconcile`, {
    items: [{ itemId: t6Item, resolution: "returned", reason: "Destino intenta devolver mercancía a origen (QA)" }],
  });
  check("solo la sucursal origen declara la devolución -> 403", returnWrongBranch.status === 403, `status ${returnWrongBranch.status}`);

  const b1BeforeReturn = await stockOf(B1, P.p2);
  const returned = await api("qa_inv_b1", "POST", `/api/transfers/${t6}/reconcile`, {
    items: [{ itemId: t6Item, resolution: "returned", reason: "La unidad nunca salió de origen; vuelve al estante (QA)" }],
  });
  check("devolución a origen registrada por el origen -> 200", returned.status === 200, `status ${returned.status} ${str(returned.body, "error")}`);
  check("devolución repone la unidad en el inventario de origen", (await stockOf(B1, P.p2)) === b1BeforeReturn + 1, `antes ${b1BeforeReturn}`);
  const t6Movement = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM farmacia.inventory_movements
     WHERE reference_type = 'transfer' AND reference_id = $1 AND movement_type = 'adjustment_in'`,
    [t6],
  );
  check("devuelve deja movimiento de ajuste trazable en origen", t6Movement.rows[0].n === 1, `movimientos ${t6Movement.rows[0].n}`);

  // -------------------------------------------------------------------------------
  console.log("\n=== G. REPORTES (desde PostgreSQL) ===");

  const sellerReport = await api("qa_seller_b1", "GET", `/api/reports?report=sales-by-period&branchId=${B1}&from=${today}&to=${today}`);
  check("vendedor sin reports.view no accede a reportes -> 403", sellerReport.status === 403, `status ${sellerReport.status}`);

  // El farmacéutico de sucursal 1 sí tiene reports.view en su sucursal.
  const reportSales = await api("qa_pharm_b1", "GET", `/api/reports?report=sales-by-period&branchId=${B1}&from=${today}&to=${today}`);
  check("farmacéutico accede al reporte de su sucursal -> 200", reportSales.status === 200, `status ${reportSales.status}`);
  const reportRows = arr(reportSales.body, "rows");
  const reportTotal = reportRows.reduce((sum, row) => sum + Number(row.total), 0);
  const dbTotal = await db.query<{ t: string }>(
    `SELECT COALESCE(SUM(total), 0)::text AS t FROM farmacia.sales
     WHERE branch_id = $1 AND status = 'completed'
       AND created_at >= ($2::date)::timestamp AT TIME ZONE 'America/Santo_Domingo'
       AND created_at < (($2::date) + 1)::timestamp AT TIME ZONE 'America/Santo_Domingo'`,
    [B1, today],
  );
  check("reporte de ventas coincide con la base de datos", Math.abs(reportTotal - Number(dbTotal.rows[0].t)) < 0.01, `reporte ${reportTotal} base ${dbTotal.rows[0].t}`);

  const reportCross = await api("qa_pharm_b1", "GET", `/api/reports?report=sales-by-period&branchId=${B2}&from=${today}&to=${today}`);
  check("reporte de otra sucursal sin permiso -> 403", reportCross.status === 403, `status ${reportCross.status}`);

  const reportNames = ["sales-by-branch", "top-products", "profitability", "purchases", "stock-levels", "expiring", "movements", "branch-performance"];
  const reportStatuses: number[] = [];
  for (const name of reportNames) {
    reportStatuses.push((await api("qa_owner", "GET", `/api/reports?report=${name}&from=${today}&to=${today}`)).status);
  }
  check("todos los reportes responden 200 para el propietario", reportStatuses.every((code) => code === 200), reportStatuses.join(","));

  const byPharmacist = await api("qa_pharm_b1", "GET", `/api/reports?report=sales-by-branch&from=${today}&to=${today}`);
  const pharmacistBranches = arr(byPharmacist.body, "rows").map((row) => row.branch_id);
  check("reporte de todas las sucursales solo incluye las autorizadas", pharmacistBranches.length === 1 && pharmacistBranches[0] === B1, JSON.stringify(pharmacistBranches));

  // Exportación a CSV.
  const csvResponse = await fetch(
    BASE + `/api/reports?report=sales-by-period&branchId=${B1}&from=${today}&to=${today}&format=csv`,
    { headers: { Cookie: await sessionFor("qa_pharm_b1") } },
  );
  const csvBuffer = Buffer.from(await csvResponse.arrayBuffer());
  const csvText = csvBuffer.toString("utf8");
  const hasBom = csvBuffer[0] === 0xef && csvBuffer[1] === 0xbb && csvBuffer[2] === 0xbf;
  const csvHeader = csvText.replace(/\r?\n$/, "").split(/\r\n/)[0] ?? "";
  check(
    "CSV de su sucursal -> 200, text/csv y con BOM",
    csvResponse.status === 200
      && (csvResponse.headers.get("content-type") ?? "").includes("text/csv")
      && hasBom,
    `status ${csvResponse.status} type ${csvResponse.headers.get("content-type")} bom ${hasBom}`,
  );
  check("CSV trae encabezados legibles del reporte", csvHeader.includes("Día") && csvHeader.includes("Ventas") && csvHeader.includes("Total"), csvHeader);
  check("CSV incluye las filas del reporte JSON", csvText.split(/\r\n/).length >= reportRows.length + 1, `csv ${csvText.split(/\r\n/).length} json ${reportRows.length}`);

  const csvCross = await fetch(
    BASE + `/api/reports?report=sales-by-period&branchId=${B2}&from=${today}&to=${today}&format=csv`,
    { headers: { Cookie: await sessionFor("qa_pharm_b1") } },
  );
  check("CSV de otra sucursal sin permiso -> 403", csvCross.status === 403, `status ${csvCross.status}`);

  const csvAnonymous = await fetch(BASE + `/api/reports?report=sales-by-period&from=${today}&to=${today}&format=csv`);
  check("CSV sin sesión -> 401", csvAnonymous.status === 401, `status ${csvAnonymous.status}`);

  // -------------------------------------------------------------------------------
  console.log("\n=== H. ASISTENTES (web y WhatsApp) ===");

  const web = async (message: string, ip = "198.51.100.10") => api(null, "POST", "/api/assistant/web", { message }, { "x-forwarded-for": ip });

  const greet = await web("hola");
  check("asistente saluda", greet.body.intent === "greeting", JSON.stringify(greet.body));

  const clinical = await web("¿Qué me recomiendas para la tos?", "198.51.100.11");
  check("consulta clínica se deriva a farmacéutico", clinical.body.intent === "clinical" && arr(clinical.body, "products").length === 0 && /farmac/i.test(str(clinical.body, "reply")), JSON.stringify(clinical.body));

  const fever = await web("tengo fiebre y dolor de cabeza desde ayer", "198.51.100.12");
  check("síntomas se derivan a farmacéutico", fever.body.intent === "clinical", JSON.stringify(fever.body));

  const emergency = await web("emergencia, no respiro bien", "198.51.100.13");
  check("emergencia recibe instrucción de 911", emergency.body.intent === "emergency" && /911/.test(str(emergency.body, "reply")), JSON.stringify(emergency.body));

  const availability = await web("¿Tienen QA PRUEBA VENTA?", "198.51.100.14");
  const product = arr(availability.body, "products")[0] ?? {};
  // Quitando la presentación y el precio (datos comerciales permitidos), no debe quedar ningún número.
  const replyWithoutAllowed = str(availability.body, "reply")
    .replace(String(product.presentation ?? ""), "")
    .replace(String(product.price ?? ""), "");
  check("disponibilidad: responde sí/no sin cantidades", availability.body.intent === "product" && product.available === true && !/\d/.test(replyWithoutAllowed), str(availability.body, "reply"));
  check("producto incluye presentación y unidad de venta", product.saleUnit === "tableta" && String(product.presentation).includes("Caja"), JSON.stringify(product));
  check("respuesta no contiene campos de cantidad de inventario", !("quantity" in product) && !("available_quantity" in product) && !("stock" in product), Object.keys(product).join(","));

  const priceQuery = await web("cuanto cuesta QA PRUEBA VENTA", "198.51.100.15");
  check("precio: informa rango de precio del catálogo", /100\.00/.test(str(priceQuery.body, "reply")), str(priceQuery.body, "reply"));

  const unknown = await web("xyzabc medicamento inexistente", "198.51.100.16");
  check("producto inexistente: no inventa información", unknown.body.intent === "not_found" && arr(unknown.body, "products").length === 0, JSON.stringify(unknown.body));

  const unverified = await web("QA PRUEBA NO VERIFICADO", "198.51.100.17");
  check("producto no verificado no se informa", unverified.body.intent === "not_found", JSON.stringify(unverified.body));

  const flood: number[] = [];
  const stamp = Date.now();
  const floodIp = `10.${(stamp >> 16) & 255}.${(stamp >> 8) & 255}.${stamp & 255}`;
  for (let i = 0; i < 21; i++) flood.push((await web("hola", floodIp)).status);
  check("límite de consultas web: 429 tras 20 por minuto", flood[20] === 429 && flood[0] === 200, flood.join(","));

  const verifyOk = await fetch(`${BASE}/api/assistant/whatsapp?hub.mode=subscribe&hub.verify_token=qa-verify-token&hub.challenge=12345`);
  check("webhook WhatsApp: verificación con token correcto", verifyOk.status === 200 && (await verifyOk.text()) === "12345", `status ${verifyOk.status}`);

  const verifyBad = await fetch(`${BASE}/api/assistant/whatsapp?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=1`);
  check("webhook WhatsApp: token incorrecto -> 403", verifyBad.status === 403, `status ${verifyBad.status}`);

  const waBody = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: "18095550123", type: "text", text: { body: "hola" } }] } }] }] });
  const noSignature = await fetch(`${BASE}/api/assistant/whatsapp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: waBody });
  check("webhook WhatsApp sin firma -> 401", noSignature.status === 401, `status ${noSignature.status}`);

  const signature = `sha256=${createHmac("sha256", WHATSAPP_SECRET).update(waBody, "utf8").digest("hex")}`;
  const signed = await fetch(`${BASE}/api/assistant/whatsapp`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-hub-signature-256": signature }, body: waBody,
  });
  const signedJson = (await signed.json()) as Body;
  check("webhook WhatsApp con firma válida procesa el mensaje", signed.status === 200 && signedJson.processed === 1 && signedJson.delivered === 0, JSON.stringify(signedJson));

  // -------------------------------------------------------------------------------
  console.log("\n=== I. CONFIGURACIÓN Y AUDITORÍA ===");

  const settingsByAdmin = await api("qa_admin_b1", "PATCH", "/api/settings", { key: "pharmacy_name", value: "QA" });
  check("administrador no puede cambiar configuración -> 403", settingsByAdmin.status === 403, `status ${settingsByAdmin.status}`);

  const settingsByOwner = await api("qa_owner", "PATCH", "/api/settings", { key: "receipt_footer", value: "Comprobante no fiscal. Gracias por su compra." });
  check("propietario guarda configuración -> 200", settingsByOwner.status === 200, `status ${settingsByOwner.status}`);

  const auditRows = await db.query<{ action: string; n: number }>(
    `SELECT action, COUNT(*)::int AS n FROM farmacia.audit_logs
     WHERE action IN ('sale.create','sale.cancel','transfer.request','transfer.approve','transfer.dispatch','transfer.receive','transfer.reject','transfer.reconcile',
                      'customer.create','customer.consent_granted','customer.consent_revoked','catalog.verify','catalog.price_change',
                      'catalog.update','password.change','password.change_failed','password.reset_cli','login','login_failed','assistant.web_query','settings.update')
     GROUP BY action`,
  );
  const auditMap = new Map(auditRows.rows.map((row) => [row.action, row.n]));
  const requiredAudit = ["sale.create", "sale.cancel", "transfer.request", "transfer.approve", "transfer.dispatch", "transfer.receive", "transfer.reject", "transfer.reconcile", "customer.create", "customer.consent_revoked", "catalog.verify", "catalog.price_change", "catalog.update", "password.change", "password.reset_cli", "login", "login_failed", "settings.update"];
  const missingAudit = requiredAudit.filter((action) => !auditMap.get(action));
  check("auditoría registra todas las operaciones sensibles probadas", missingAudit.length === 0, `faltan: ${missingAudit.join(", ")}`);

  // -------------------------------------------------------------------------------
  console.log("\n=== J. INVARIANTES DE INVENTARIO (base de datos) ===");

  const negative = await db.query<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM farmacia.inventory_stock WHERE quantity_on_hand < 0 OR quantity_reserved < 0)::int
          + (SELECT COUNT(*) FROM farmacia.inventory_lots WHERE quantity_remaining < 0)::int AS n`,
  );
  check("ningún inventario ni lote en negativo", negative.rows[0].n === 0, `casos ${negative.rows[0].n}`);

  const mismatch = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM farmacia.inventory_stock s
     WHERE s.product_id = ANY($1::uuid[])
       AND s.quantity_on_hand <> COALESCE((SELECT SUM(l.quantity_remaining) FROM farmacia.inventory_lots l
             WHERE l.branch_id = s.branch_id AND l.product_id = s.product_id), 0)`,
    [[P.p1, P.p2, P.p3]],
  );
  check("existencias = suma de lotes en productos QA", mismatch.rows[0].n === 0, `diferencias ${mismatch.rows[0].n}`);

  const transferBalance = await db.query<{ dispatched: number; received: number; missing: number }>(
    `SELECT COALESCE(SUM(quantity_dispatched),0)::int AS dispatched,
            COALESCE(SUM(quantity_received),0)::int AS received,
            COALESCE(SUM(quantity_missing),0)::int AS missing
     FROM farmacia.transfer_items WHERE transfer_id = $1`,
    [t1],
  );
  const tb = transferBalance.rows[0];
  check("transferencia cuadra: despachado = recibido + faltante", tb.dispatched === tb.received + tb.missing && tb.missing === 1, JSON.stringify(tb));

  const salesBalance = await db.query<{ bad: number }>(
    `SELECT COUNT(*)::int AS bad FROM farmacia.sales s
     WHERE s.status = 'completed'
       AND s.total <> (SELECT COALESCE(SUM(si.line_total),0) FROM farmacia.sale_items si WHERE si.sale_id = s.id)`,
  );
  check("totales de ventas completadas cuadran con sus líneas", salesBalance.rows[0].bad === 0, `ventas con diferencia ${salesBalance.rows[0].bad}`);

  // -------------------------------------------------------------------------------
  console.log("\n=== K. GESTIÓN DE EMPLEADOS (al final: altera cuentas QA) ===");

  const userId = async (username: string) =>
    (await db.query<{ id: string }>(`SELECT id FROM farmacia.users WHERE username = $1`, [username])).rows[0].id;
  const sellerB2Id = await userId("qa_seller_b2");
  const ownerId = await userId("qa_owner");
  const otherOwnerId = (await db.query<{ id: string }>(
    `SELECT u.id FROM farmacia.users u JOIN farmacia.user_roles ur ON ur.user_id = u.id
     JOIN farmacia.roles r ON r.id = ur.role_id WHERE r.code = 'owner' AND u.username <> 'qa_owner' LIMIT 1`,
  )).rows[0]?.id;

  const adminManages = await api("qa_admin_b1", "PATCH", `/api/users/${sellerB2Id}`, { action: "deactivate" });
  check("administrador no puede administrar empleados -> 403", adminManages.status === 403, `status ${adminManages.status}`);

  const selfAction = await api("qa_owner", "PATCH", `/api/users/${ownerId}`, { action: "deactivate" });
  check("propietario no puede desactivarse a sí mismo -> 400", selfAction.status === 400, `status ${selfAction.status}`);

  if (otherOwnerId) {
    const ownerTarget = await api("qa_owner", "PATCH", `/api/users/${otherOwnerId}`, { action: "reset_password" });
    check("cuentas de propietario protegidas -> 403", ownerTarget.status === 403, `status ${ownerTarget.status}`);
  }

  const sellerB2Before = await api("qa_seller_b2", "GET", `/api/sales?branchId=${B2}`);
  const deactivate = await api("qa_owner", "PATCH", `/api/users/${sellerB2Id}`, { action: "deactivate" });
  const afterDeactivate = await api("qa_seller_b2", "GET", `/api/sales?branchId=${B2}`);
  check("desactivar empleado revoca su sesión al instante", sellerB2Before.status === 200 && deactivate.status === 200 && afterDeactivate.status === 401, `${sellerB2Before.status}/${deactivate.status}/${afterDeactivate.status}`);

  const loginInactive = await login("qa_seller_b2", accounts.get("qa_seller_b2") ?? "");
  check("empleado desactivado no puede iniciar sesión", loginInactive.status === 401, `status ${loginInactive.status}`);

  const activate = await api("qa_owner", "PATCH", `/api/users/${sellerB2Id}`, { action: "activate" });
  check("propietario reactiva empleado -> 200", activate.status === 200, `status ${activate.status}`);

  const roleChange = await api("qa_owner", "PATCH", `/api/users/${sellerB2Id}`, { action: "set_role", roleCode: "pharmacist", branchId: B2 });
  cookies.delete("qa_seller_b2");
  const asPharmacist = await api("qa_seller_b2", "GET", `/api/reports?report=sales-by-period&branchId=${B2}&from=${today}&to=${today}`);
  check("cambio de rol surte efecto de inmediato (ahora ve reportes)", roleChange.status === 200 && asPharmacist.status === 200, `${roleChange.status}/${asPharmacist.status}`);

  const reset = await api("qa_owner", "PATCH", `/api/users/${sellerB2Id}`, { action: "reset_password" });
  const temporaryForEmployee = str(reset.body, "temporaryPassword");
  const afterReset = await api("qa_seller_b2", "GET", `/api/sales?branchId=${B2}`);
  const loginWithTemporary = await login("qa_seller_b2", temporaryForEmployee);
  check("restablecer contraseña: sesión revocada y obliga a cambiarla", reset.status === 200 && temporaryForEmployee.length >= 12 && afterReset.status === 401 && loginWithTemporary.body.redirectTo === "/cambiar-contrasena", `${reset.status}/${afterReset.status}/${String(loginWithTemporary.body.redirectTo)}`);

  const auditUsers = await db.query<{ n: number }>(
    `SELECT COUNT(DISTINCT action)::int AS n FROM farmacia.audit_logs
     WHERE entity_id = $1 AND action IN ('user.deactivate','user.activate','user.role_change','user.password_reset')`,
    [sellerB2Id],
  );
  check("acciones sobre empleados quedan auditadas", auditUsers.rows[0].n === 4, `acciones distintas ${auditUsers.rows[0].n}`);

  // -------------------------------------------------------------------------------
  console.log("\n=== L. RESTAURACIÓN ===");

  // La sección K altera la cuenta qa_seller_b2 (rol y contraseña). Para que
  // scripts/qa/pages.ts pueda correr a continuación sin repetir qa:setup,
  // se restituye rol y contraseña según el archivo de cuentas QA.
  const sellerB2Account = data.accounts.find((account) => account.username === "qa_seller_b2");
  const roleIdRestore = (await db.query<{ id: string }>(`SELECT id FROM farmacia.roles WHERE code = 'seller'`)).rows[0]?.id;
  if (sellerB2Account && roleIdRestore) {
    const sellerB2User = (await db.query<{ id: string }>(
      `SELECT id FROM farmacia.users WHERE LOWER(username) = 'qa_seller_b2'`,
    )).rows[0];
    if (sellerB2User) {
      await db.query(`DELETE FROM farmacia.user_roles WHERE user_id = $1`, [sellerB2User.id]);
      await db.query(
        `INSERT INTO farmacia.user_roles (user_id, role_id, branch_id) VALUES ($1, $2, $3)`,
        [sellerB2User.id, roleIdRestore, B2],
      );
      await db.query(
        `UPDATE farmacia.users SET password_hash = $2, must_change_password = FALSE WHERE id = $1`,
        [sellerB2User.id, await hashPassword(sellerB2Account.password)],
      );
      cookies.delete("qa_seller_b2");
      const restored = await login("qa_seller_b2", sellerB2Account.password);
      check("restauración: qa_seller_b2 vuelve a su rol y contraseña originales", restored.status === 200, `status ${restored.status}`);
    }
  }

  // -------------------------------------------------------------------------------
  console.log("\n=== RESUMEN ===");
  console.log(`Pruebas aprobadas: ${passed}`);
  console.log(`Pruebas fallidas: ${failed}`);
  if (failures.length > 0) {
    console.log("Fallidas:");
    for (const name of failures) console.log(`  - ${name}`);
  }
}

run()
  .catch((error) => {
    console.error("ERROR EN LAS PRUEBAS:", error instanceof Error ? error.message : error);
    failed += 1;
  })
  .finally(async () => {
    await db.end().catch(() => undefined);
    process.exitCode = failed > 0 ? 1 : 0;
  });
