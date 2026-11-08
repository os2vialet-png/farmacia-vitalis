/**
 * Restablece la contraseña de un usuario desde la consola del servidor.
 *
 * Es el procedimiento de recuperación cuando el propietario pierde su contraseña.
 * Solo puede ejecutarlo quien tiene acceso al servidor y a la base de datos.
 *
 * Uso:
 *   npx tsx scripts/reset-owner-password.ts <usuario>
 *
 * Efectos:
 * - Genera una contraseña temporal que se muestra UNA sola vez en esta terminal.
 * - Marca must_change_password = TRUE: el usuario debe cambiarla al entrar.
 * - Revoca todas las sesiones activas de ese usuario.
 * - Registra la acción en farmacia.audit_logs (acción password.reset_cli).
 * - No muestra ni guarda la cadena de conexión.
 */
import { randomInt } from "node:crypto";
import { createInterface } from "node:readline";
import { hostname, userInfo } from "node:os";
import { Pool } from "pg";
import { hashPassword } from "../src/lib/auth/password";

const CONFIRMATION = "RESTABLECER";
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

function generateTemporaryPassword(length = 20): string {
  // Garantiza al menos una letra y un número para cumplir la política.
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const chars: string[] = [
    letters[randomInt(letters.length)],
    digits[randomInt(digits.length)],
  ];
  while (chars.length < length) {
    chars.push(ALPHABET[randomInt(ALPHABET.length)]);
  }
  // Mezcla Fisher-Yates con CSPRNG.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const username = process.argv[2]?.trim();

  if (!username) {
    throw new Error("Indica el usuario: npx tsx scripts/reset-owner-password.ts <usuario>");
  }

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("Falta DATABASE_URL. Carga .env.local o define la variable antes de ejecutar.");
  }

  const pool = new Pool({ connectionString });

  try {
    const userResult = await pool.query<{ id: string; username: string; is_active: boolean; role_codes: string[] }>(
      `SELECT u.id, u.username, u.is_active,
              COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS role_codes
       FROM farmacia.users u
       LEFT JOIN farmacia.user_roles ur ON ur.user_id = u.id
       LEFT JOIN farmacia.roles r ON r.id = ur.role_id
       WHERE LOWER(u.username) = LOWER($1)
       GROUP BY u.id`,
      [username],
    );

    if (userResult.rows.length === 0) {
      throw new Error("No existe un usuario con ese nombre.");
    }

    const user = userResult.rows[0];

    console.log(`\nUsuario: ${user.username}`);
    console.log(`Roles: ${user.role_codes.join(", ") || "ninguno"}`);
    console.log(`Estado: ${user.is_active ? "activo" : "inactivo (se reactivará)"}`);
    console.log("\nSe generará una contraseña temporal. Se mostrará una sola vez.");

    const answer = await ask(`Escribe ${CONFIRMATION} para continuar: `);

    if (answer !== CONFIRMATION) {
      console.log("Operación cancelada. No se modificó nada.");
      return;
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE farmacia.users
         SET password_hash = $2, must_change_password = TRUE, is_active = TRUE, updated_at = NOW()
         WHERE id = $1`,
        [user.id, passwordHash],
      );

      await client.query(
        `UPDATE farmacia.user_sessions
         SET revoked_at = NOW()
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [user.id],
      );

      await client.query(
        `INSERT INTO farmacia.audit_logs (actor_user_id, action, entity, entity_id, new_values)
         VALUES (NULL, 'password.reset_cli', 'user', $1, $2::jsonb)`,
        [
          user.id,
          JSON.stringify({
            username: user.username,
            operatorAccount: userInfo().username,
            operatorHost: hostname(),
          }),
        ],
      );

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    console.log("\n=== CONTRASEÑA TEMPORAL (cópiala ahora; no se volverá a mostrar) ===");
    console.log(temporaryPassword);
    console.log("=================================================================");
    console.log("Entrega esta contraseña en persona o por un canal seguro.");
    console.log("Al iniciar sesión, el sistema obligará a cambiarla.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("\nNo se restableció la contraseña:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
