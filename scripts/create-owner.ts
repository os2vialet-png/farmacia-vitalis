
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { Pool } from "pg";

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});
import { hashPassword } from "../src/lib/auth/password";

function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function askSecret(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY || !stdin.setRawMode) {
      reject(new Error("Ejecuta este script desde una terminal interactiva."));
      return;
    }

    stdout.write(question);
    let value = "";

    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (data: Buffer) => {
      for (const char of data.toString()) {
        if (char === "\u0003") {
          cleanup();
          stdout.write("\n");
          reject(new Error("Operación cancelada."));
          return;
        }

        if (char === "\r" || char === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value);
          return;
        }

        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }

        if (char >= " " && char <= "~") {
          value += char;
        }
      }
    };

    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
  });
}

async function main() {
  console.log("\n=== CONFIGURACIÓN DEL PROPIETARIO ===\n");

  const username = await ask("Usuario de acceso: ");
  const firstName = await ask("Nombre: ");
  const lastName = await ask("Apellido: ");
  const email = await ask("Correo (opcional): ");
  const phone = await ask("Teléfono (opcional): ");

  const branchName = await ask("Nombre de la sucursal principal: ");
  const branchAddress = await ask("Dirección de la sucursal: ");
  const branchPhone = await ask("Teléfono de la sucursal: ");

  const password = await askSecret("Contraseña (mínimo 12 caracteres): ");
  const confirmation = await askSecret("Confirma la contraseña: ");

  if (!username || !firstName || !lastName || !branchName) {
    throw new Error("Completa los campos obligatorios.");
  }

  if (password !== confirmation) {
    throw new Error("Las contraseñas no coinciden.");
  }

  const passwordHash = await hashPassword(password);
  const client = await db.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      `SELECT id FROM farmacia.users
       WHERE LOWER(username) = LOWER($1)
       LIMIT 1`,
      [username],
    );

    if (existing.rows.length > 0) {
      throw new Error("Ese nombre de usuario ya existe.");
    }

    const branch = await client.query(
      `INSERT INTO farmacia.branches
        (code, name, address, phone)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        "VITALIS-001",
        branchName,
        branchAddress || null,
        branchPhone || null,
      ],
    );

    const user = await client.query(
      `INSERT INTO farmacia.users
        (username, email, password_hash, first_name, last_name, phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        username,
        email || null,
        passwordHash,
        firstName,
        lastName,
        phone || null,
      ],
    );

    const ownerRole = await client.query(
      `SELECT id FROM farmacia.roles
       WHERE code = 'owner'
       LIMIT 1`,
    );

    if (ownerRole.rows.length === 0) {
      throw new Error("No existe el rol owner en la base de datos.");
    }

    await client.query(
      `INSERT INTO farmacia.user_roles
        (user_id, role_id, branch_id)
       VALUES ($1, $2, NULL)`,
      [user.rows[0].id, ownerRole.rows[0].id],
    );

    await client.query(
      `INSERT INTO farmacia.audit_logs
        (actor_user_id, branch_id, action, entity, entity_id, new_values)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        user.rows[0].id,
        branch.rows[0].id,
        "initial_owner_created",
        "user",
        user.rows[0].id,
        JSON.stringify({ username }),
      ],
    );

    await client.query("COMMIT");

    console.log("\n¡PROPIETARIO CREADO EXITOSAMENTE!");
    console.log("Usuario:", username);
    console.log("Sucursal:", branchName);
    console.log("Rol: Propietario global");
    console.log("Contraseña: guardada mediante hash seguro");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await db.end();
  }
}

main().catch((error) => {
  console.error("\nNo se pudo crear el propietario:", error.message);
  db.end();
  process.exitCode = 1;
});
