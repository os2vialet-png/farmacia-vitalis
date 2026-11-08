/**
 * Prepara una transferencia recibida con diferencia SIN conciliar, para revisar la
 * interfaz en el navegador. Usa la API real con cuentas QA.
 *   npx tsx scripts/qa/demo-transfer.ts
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..", "..");
const BASE = "http://localhost:3100";

const data = JSON.parse(readFileSync(join(ROOT, "backups", "qa-accounts.json"), "utf8")) as {
  branches: { b1: string; b2: string };
  products: Record<string, string>;
  accounts: { username: string; password: string }[];
};

const passwords = new Map(data.accounts.map((account) => [account.username, account.password]));

async function login(username: string): Promise<string> {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: passwords.get(username) }),
  });
  if (response.status !== 200) throw new Error(`login ${username}: ${response.status}`);
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

async function post(user: string, path: string, body: unknown) {
  const response = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: await login(user) },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as { error?: string; transfer?: { id: string; items?: { id: string }[] } };
  if (response.status >= 300) throw new Error(`${path}: ${response.status} ${json.error ?? ""}`);
  return json;
}

async function main() {
  const created = await post("qa_inv_b2", "/api/transfers", {
    originBranchId: data.branches.b1,
    destinationBranchId: data.branches.b2,
    items: [{ productId: data.products.p2, quantity: 2 }],
  });
  const transferId = created.transfer?.id as string;
  const itemId = created.transfer?.items?.[0]?.id as string;

  await post("qa_admin_b1", `/api/transfers/${transferId}/approve`, {
    items: [{ itemId, quantityApproved: 2 }],
  });
  await post("qa_inv_b1", `/api/transfers/${transferId}/dispatch`, {});
  await post("qa_inv_b2", `/api/transfers/${transferId}/receive`, {
    items: [{ itemId, quantityReceived: 1, discrepancyReason: "Demo: una unidad sin llegar antes de conciliar (QA)" }],
  });

  console.log(`Transferencia lista (diferencia pendiente): ${transferId}`);
  console.log(`Abrir: ${BASE}/transferencias/${transferId}`);
}

main().catch((error) => {
  console.error("ERROR:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
