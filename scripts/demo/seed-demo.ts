/**
 * Carga datos de DEMOSTRACIÓN usando la API real del sistema (no SQL directo),
 * para que cada módulo muestre información y se vea funcionando.
 *
 *   npm run build && npm run start -- -p 3100      (en otra terminal)
 *   npx tsx scripts/demo/seed-demo.ts
 *
 * Crea: 4 productos "(DEMO)" verificados con precio en 2 sucursales, 2 suplidores, 2 compras
 * recibidas (lotes y vencimientos), 2 clientes, ventas (una anulada), 2 transferencias
 * (una completa y una pendiente), 2 empleados y un mínimo de reposición que dispara alertas.
 * Todo lleva "(demo)"/"(DEMO)". Para borrarlo: npx tsx scripts/demo/remove-demo.ts
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { hashPassword } from "../../src/lib/auth/password";

const ROOT = resolve(__dirname, "..", "..");
const BASE = process.env.DEMO_BASE_URL ?? "http://localhost:3100";

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const match = readFileSync(join(ROOT, ".env.local"), "utf8").match(/^DATABASE_URL=(.*)$/m);
  if (!match) throw new Error("Falta DATABASE_URL.");
  return match[1].trim().replace(/^"|"$/g, "");
}

type Json = Record<string, unknown>;
let cookie = "";

async function api(method: string, path: string, body?: unknown): Promise<Json> {
  const response = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${String(data.error ?? "")}`);
  return data;
}

const obj = (value: unknown) => (value ?? {}) as Json;
const dateIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const PRODUCTS = [
  { key: "A", name: "ACETAMINOFEN 500 MG (DEMO)", form: "Tableta", strength: "500 mg", presentation: "Caja x 100 tabletas", unit: "caja", brand: "Genérico (demo)", rx: false, prices: [350, 360] },
  { key: "B", name: "AMOXICILINA 500 MG (DEMO)", form: "Cápsula", strength: "500 mg", presentation: "Caja x 21 cápsulas", unit: "caja", brand: "Genérico (demo)", rx: true, prices: [480, 495] },
  { key: "C", name: "IBUPROFENO 100 MG/5 ML (DEMO)", form: "Suspensión oral", strength: "100 mg/5 ml", presentation: "Frasco x 120 ml", unit: "frasco", brand: "Genérico (demo)", rx: false, prices: [275, 280] },
  { key: "D", name: "LORATADINA 10 MG (DEMO)", form: "Tableta", strength: "10 mg", presentation: "Caja x 10 tabletas", unit: "caja", brand: "Genérico (demo)", rx: false, prices: [190, 195] },
] as const;

async function main() {
  const db = new Client({ connectionString: databaseUrl() });
  await db.connect();

  const already = await db.query(`SELECT 1 FROM farmacia.catalog_products WHERE source_external_id LIKE 'DEMO-%' AND is_active LIMIT 1`);
  if (already.rows.length > 0) {
    await db.end();
    throw new Error("Ya hay datos de demostración. Bórralos primero con scripts/demo/remove-demo.ts.");
  }

  const branches = await db.query<{ id: string; code: string }>(
    `SELECT id, code FROM farmacia.branches WHERE code IN ('VITALIS-001', 'VITALIS-002') AND is_active`,
  );
  const VM = branches.rows.find((b) => b.code === "VITALIS-001")?.id;
  const SA = branches.rows.find((b) => b.code === "VITALIS-002")?.id;
  if (!VM || !SA) throw new Error("Faltan las sucursales VITALIS-001 y VITALIS-002 (crea la demo con create-demo-branch.ts).");

  // Cuenta técnica temporal (propietario) para operar por la API; se desactiva al final.
  const password = `${randomBytes(18).toString("base64url")}7k`;
  const hash = await hashPassword(password);
  const existing = await db.query<{ id: string }>(`SELECT id FROM farmacia.users WHERE username = 'demo_sistema'`);
  let demoUserId: string;
  if (existing.rows.length > 0) {
    demoUserId = existing.rows[0].id;
    await db.query(`UPDATE farmacia.users SET password_hash = $2, is_active = TRUE, must_change_password = FALSE WHERE id = $1`, [demoUserId, hash]);
  } else {
    const created = await db.query<{ id: string }>(
      `INSERT INTO farmacia.users (username, password_hash, first_name, last_name, is_active, must_change_password)
       VALUES ('demo_sistema', $1, 'Sistema', 'Demo', TRUE, FALSE) RETURNING id`, [hash]);
    demoUserId = created.rows[0].id;
  }
  await db.query(`DELETE FROM farmacia.user_roles WHERE user_id = $1`, [demoUserId]);
  await db.query(`INSERT INTO farmacia.user_roles (user_id, role_id, branch_id) SELECT $1, id, NULL FROM farmacia.roles WHERE code = 'owner'`, [demoUserId]);

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "demo_sistema", password }),
  });
  if (login.status !== 200) throw new Error(`No se pudo iniciar sesión con la cuenta demo (${login.status}).`);
  cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];

  try {
    // 1. Productos: alta, datos comerciales, verificación y precios por sucursal.
    const ids: Record<string, string> = {};
    for (const product of PRODUCTS) {
      const created = await api("POST", "/api/catalog", { productName: product.name, dosageForm: product.form, strength: product.strength });
      const id = String(obj(created.product).id);
      ids[product.key] = id;
      await db.query(`UPDATE farmacia.catalog_products SET source_external_id = $2 WHERE id = $1`, [id, `DEMO-${product.key}`]);
      await api("PATCH", `/api/catalog/${id}`, {
        brandName: product.brand, presentation: product.presentation, saleUnit: product.unit, taxPercent: null, isActive: true, isPrescription: product.rx,
      });
      await api("POST", `/api/catalog/${id}/verify`, {
        status: "verified", evidenceType: "manual_review", evidenceReference: "DEMO",
        notes: "Producto de demostración creado para mostrar el funcionamiento del sistema.",
      });
      await api("POST", `/api/catalog/${id}/prices`, { branchId: VM, salePrice: product.prices[0] });
      await api("POST", `/api/catalog/${id}/prices`, { branchId: SA, salePrice: product.prices[1] });
    }
    console.log("✔ 4 productos demo verificados con precio en 2 sucursales");

    // 2. Suplidores.
    const s1 = String(obj((await api("POST", "/api/suppliers", { name: "Distribuidora Caribe Farma (demo)", taxId: "000-00000-0", contactName: "Rosa Taveras", phone: "809-555-0190", paymentTerms: "30 días" })).supplier).id);
    const s2 = String(obj((await api("POST", "/api/suppliers", { name: "Laboratorios del Norte (demo)", contactName: "Héctor Gil", phone: "829-555-0133", paymentTerms: "Contado" })).supplier).id);
    console.log("✔ 2 suplidores demo");

    // 3. Compras: orden → aprobación → recepción con lote y vencimiento.
    async function purchase(branchId: string, supplierId: string, lines: { key: string; qty: number; cost: number; days: number }[]) {
      const order = await api("POST", "/api/purchases", {
        branchId, supplierId, taxAmount: 0, notes: "Compra de demostración",
        items: lines.map((line) => ({ productId: ids[line.key], quantity: line.qty, unitCost: line.cost })),
      });
      const orderId = String(obj(order.order).id);
      await api("PATCH", `/api/purchases/${orderId}`, { action: "order" });
      const detail = await api("GET", `/api/purchases/${orderId}`);
      const items = detail.items as { id: string; product_id: string }[];
      await api("POST", `/api/purchases/${orderId}/receipts`, {
        items: lines.map((line) => ({
          purchaseOrderItemId: items.find((item) => item.product_id === ids[line.key])!.id,
          quantityReceived: line.qty,
          lotNumber: `DEMO-${line.key}-${branchId === VM ? "VM" : "SA"}`,
          expirationDate: dateIn(line.days),
          unitCost: line.cost,
        })),
      });
    }
    await purchase(VM, s1, [
      { key: "A", qty: 60, cost: 200, days: 540 },
      { key: "B", qty: 40, cost: 300, days: 365 },
      { key: "C", qty: 12, cost: 150, days: 20 },
      { key: "D", qty: 8, cost: 100, days: 300 },
    ]);
    await purchase(SA, s2, [
      { key: "A", qty: 30, cost: 200, days: 500 },
      { key: "B", qty: 10, cost: 300, days: 400 },
      { key: "D", qty: 25, cost: 100, days: 330 },
    ]);
    console.log("✔ 2 compras recibidas con lotes (un lote vence en 20 días)");

    // 4. Mínimo de reposición: Loratadina en Villa Mella queda bajo su mínimo.
    await api("PATCH", "/api/inventory/alerts", { branchId: VM, productId: ids.D, minimumStock: 10, maximumStock: 60, reorderPoint: 12 });
    console.log("✔ Mínimo de reposición configurado (genera alerta de stock bajo)");

    // 5. Clientes.
    const c1 = String((await api("POST", "/api/customers", {
      fullName: "Carmen Peña (demo)", phone: "809-555-0110", privacyAccepted: true,
      commercialConsents: [{ type: "commercial_whatsapp", granted: true }],
    })).id);
    await api("POST", "/api/customers", { fullName: "José Almonte (demo)", phone: "829-555-0177", privacyAccepted: true });
    console.log("✔ 2 clientes demo");

    // 6. Ventas (una se anula para mostrar el flujo de anulación).
    const key = () => `demo-${randomBytes(8).toString("hex")}`;
    await api("POST", "/api/sales", {
      branchId: VM, customerId: c1, idempotencyKey: key(),
      items: [{ productId: ids.A, quantity: 2 }, { productId: ids.D, quantity: 1 }],
      payments: [{ method: "cash", amount: 1000 }],
    });
    await api("POST", "/api/sales", {
      branchId: VM, idempotencyKey: key(),
      items: [{ productId: ids.B, quantity: 1 }, { productId: ids.C, quantity: 1 }],
      payments: [{ method: "card", amount: 755, reference: "DEMO-4521" }],
    });
    await api("POST", "/api/sales", {
      branchId: SA, idempotencyKey: key(),
      items: [{ productId: ids.A, quantity: 1 }],
      payments: [{ method: "cash", amount: 400 }],
    });
    const toCancel = await api("POST", "/api/sales", {
      branchId: SA, idempotencyKey: key(),
      items: [{ productId: ids.D, quantity: 1 }],
      payments: [{ method: "cash", amount: 195 }],
    });
    await api("POST", `/api/sales/${String(obj(toCancel.sale).id)}/cancel`, { reason: "Cliente cambió de opinión (demo)" });
    console.log("✔ 4 ventas en 2 sucursales (una anulada)");

    // 7. Transferencias: una completa y una pendiente de aprobación.
    const t1 = obj((await api("POST", "/api/transfers", {
      originBranchId: VM, destinationBranchId: SA, notes: "Reposición de demostración",
      items: [{ productId: ids.A, quantity: 10 }],
    })).transfer);
    const t1Item = String((t1.items as { id: string }[])[0].id);
    await api("POST", `/api/transfers/${String(t1.id)}/approve`, { items: [{ itemId: t1Item, quantityApproved: 10 }] });
    await api("POST", `/api/transfers/${String(t1.id)}/dispatch`, {});
    await api("POST", `/api/transfers/${String(t1.id)}/receive`, { items: [{ itemId: t1Item, quantityReceived: 10 }] });
    await api("POST", "/api/transfers", {
      originBranchId: VM, destinationBranchId: SA, notes: "Solicitud pendiente de demostración",
      items: [{ productId: ids.B, quantity: 5 }],
    });
    console.log("✔ 2 transferencias (una recibida y una pendiente)");

    // 8. Empleados.
    for (const employee of [
      { username: "demo_maria", firstName: "María", lastName: "Rodríguez (demo)", branchId: VM, roleCode: "seller" },
      { username: "demo_luis", firstName: "Luis", lastName: "Peña (demo)", branchId: SA, roleCode: "pharmacist" },
    ]) {
      const exists = await db.query(`SELECT 1 FROM farmacia.users WHERE username = $1`, [employee.username]);
      if (exists.rows.length === 0) await api("POST", "/api/users", employee);
    }
    console.log("✔ 2 empleados demo (con contraseña temporal, no se muestran)");

    console.log("\nDatos de demostración cargados. Abre Inventario, Ventas, Reportes, Transferencias o el asistente.");
  } finally {
    // La cuenta técnica no queda activa.
    await db.query(`UPDATE farmacia.users SET is_active = FALSE WHERE id = $1`, [demoUserId]);
    await db.query(`UPDATE farmacia.user_sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`, [demoUserId]);
    await db.end();
  }
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
