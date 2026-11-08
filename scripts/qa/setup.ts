/**
 * Prepara datos de prueba (QA). Todo lo creado se marca con prefijo "qa_" o "QA".
 *
 *   npx tsx scripts/qa/setup.ts
 *
 * Crea: sucursal QA-002, productos de prueba (no son medicamentos reales) y una cuenta por rol.
 * Las contraseñas se escriben SOLO en backups/qa-accounts.json (ignorado por el control de cambios).
 * Al terminar las pruebas, ejecuta scripts/qa/teardown.ts para desactivar las cuentas y productos.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { hashPassword } from "../../src/lib/auth/password";

const ROOT = resolve(__dirname, "..", "..");

export type QaAccount = {
  username: string;
  password: string;
  role: string | null;
  branch: "b1" | "b2" | null;
  mustChangePassword: boolean;
};

function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const match = readFileSync(join(ROOT, ".env.local"), "utf8").match(/^DATABASE_URL=(.*)$/m);
  if (!match) throw new Error("Falta DATABASE_URL.");
  return match[1].trim().replace(/^"|"$/g, "");
}

function randomPassword(): string {
  return `${randomBytes(12).toString("base64url")}a1`;
}

async function main() {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();

  try {
    await client.query("BEGIN");

    // Sucursal de prueba.
    const branch = await client.query<{ id: string }>(
      `INSERT INTO farmacia.branches (code, name, address, phone, is_active)
       VALUES ('QA-002', 'QA Sucursal 2', 'Solo pruebas', NULL, TRUE)
       ON CONFLICT (code) DO UPDATE SET is_active = TRUE
       RETURNING id`,
    );
    const b2 = branch.rows[0].id;

    const b1 = (await client.query<{ id: string }>(
      `SELECT id FROM farmacia.branches WHERE is_active = TRUE AND code <> 'QA-002' ORDER BY created_at LIMIT 1`,
    )).rows[0].id;

    // Productos de prueba. No tienen registro sanitario: no representan medicamentos reales.
    const products = [
      { key: "p1", name: "QA PRUEBA VENTA", external: "QA-TEST-1" },
      { key: "p2", name: "QA PRUEBA TRANSFERENCIA", external: "QA-TEST-2" },
      { key: "p3", name: "QA PRUEBA NO VERIFICADO", external: "QA-TEST-3" },
    ];

    const productIds: Record<string, string> = {};
    for (const product of products) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM farmacia.catalog_products WHERE source_external_id = $1`,
        [product.external],
      );
      if (existing.rows.length > 0) {
        productIds[product.key] = existing.rows[0].id;
        await client.query(`UPDATE farmacia.catalog_products SET is_active = TRUE WHERE id = $1`, [existing.rows[0].id]);
      } else {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO farmacia.catalog_products
             (product_name, normalized_name, verification_status, is_active, source_external_id)
           VALUES ($1::text, lower($1::text), 'needs_review', TRUE, $2::text)
           RETURNING id`,
          [product.name, product.external],
        );
        productIds[product.key] = inserted.rows[0].id;
      }
    }

    // Producto inactivo de prueba: se reutiliza si ya existe (no hay restricción única sobre source_external_id).
    const existingInactive = await client.query<{ id: string }>(
      `SELECT id FROM farmacia.catalog_products WHERE source_external_id = 'QA-TEST-4' ORDER BY created_at LIMIT 1`,
    );
    if (existingInactive.rows[0]) {
      productIds.inactive = existingInactive.rows[0].id;
      await client.query(`UPDATE farmacia.catalog_products SET is_active = FALSE WHERE id = $1`, [productIds.inactive]);
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO farmacia.catalog_products
           (product_name, normalized_name, verification_status, is_active, source_external_id)
         VALUES ('QA PRUEBA INACTIVO', 'qa prueba inactivo', 'needs_review', FALSE, 'QA-TEST-4')
         RETURNING id`,
      );
      productIds.inactive = inserted.rows[0].id;
    }

    // Cuentas por rol.
    const roles = await client.query<{ id: string; code: string }>(`SELECT id, code FROM farmacia.roles`);
    const roleId = new Map(roles.rows.map((row) => [row.code, row.id]));

    // Telemetría de límite de login generada por corridas previas de QA: sin esta limpieza,
    // repetir las suites seguidas acumula fallos y dispararía el bloqueo temporal de 15 minutos.
    await client.query(
      `DELETE FROM farmacia.audit_logs
       WHERE action = 'login_failed' AND new_values->>'username' LIKE 'qa\\_%'`,
    );

    const accounts: QaAccount[] = [
      { username: "qa_admin_b1", password: randomPassword(), role: "admin", branch: "b1", mustChangePassword: false },
      { username: "qa_seller_b1", password: randomPassword(), role: "seller", branch: "b1", mustChangePassword: false },
      { username: "qa_seller_b2", password: randomPassword(), role: "seller", branch: "b2", mustChangePassword: false },
      { username: "qa_pharm_b1", password: randomPassword(), role: "pharmacist", branch: "b1", mustChangePassword: false },
      { username: "qa_inv_b1", password: randomPassword(), role: "inventory_manager", branch: "b1", mustChangePassword: false },
      { username: "qa_inv_b2", password: randomPassword(), role: "inventory_manager", branch: "b2", mustChangePassword: false },
      // Usuario nuevo por corrida: los intentos fallidos de cambio de contraseña se acumulan por usuario.
      { username: `qa_newbie_${Date.now().toString(36)}`, password: randomPassword(), role: "seller", branch: "b1", mustChangePassword: true },
      { username: "qa_norole", password: randomPassword(), role: null, branch: null, mustChangePassword: false },
      { username: "qa_owner", password: randomPassword(), role: "owner", branch: null, mustChangePassword: false },
    ];

    for (const account of accounts) {
      const hash = await hashPassword(account.password);
      const user = await client.query<{ id: string }>(
        `INSERT INTO farmacia.users (username, password_hash, first_name, last_name, is_active, must_change_password)
         VALUES ($1, $2, 'QA', $1, TRUE, $3)
         ON CONFLICT ((LOWER(username))) DO UPDATE
           SET password_hash = EXCLUDED.password_hash, is_active = TRUE, must_change_password = EXCLUDED.must_change_password
         RETURNING id`,
        [account.username, hash, account.mustChangePassword],
      );
      await client.query(`DELETE FROM farmacia.user_roles WHERE user_id = $1`, [user.rows[0].id]);
      if (account.role) {
        await client.query(
          `INSERT INTO farmacia.user_roles (user_id, role_id, branch_id) VALUES ($1, $2, $3)`,
          [
            user.rows[0].id,
            roleId.get(account.role),
            account.branch === null ? null : account.branch === "b2" ? b2 : b1,
          ],
        );
      }
    }

    // Propietario de prueba existente (qa_e2e) se reactiva con su contraseña ya conocida.
    await client.query(`UPDATE farmacia.users SET is_active = TRUE WHERE LOWER(username) = 'qa_e2e'`);

    await client.query("COMMIT");

    const dir = join(ROOT, "backups");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "qa-accounts.json"),
      JSON.stringify({ branches: { b1, b2 }, products: productIds, accounts }, null, 2),
    );

    console.log("Datos de prueba listos.");
    console.log(`Cuentas creadas: ${accounts.length} (contraseñas en backups/qa-accounts.json)`);
    console.log(`Productos QA: ${Object.keys(productIds).length}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("ERROR en preparación:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
