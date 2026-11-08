
import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { db } from "@/src/lib/db";

const COOKIE_NAME = "vitalis_session";
const SESSION_DURATION_HOURS = 12;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = hashToken(token);

  const expiresAt = new Date(
    Date.now() + SESSION_DURATION_HOURS * 60 * 60 * 1000,
  );

  await db.query(
    `INSERT INTO farmacia.user_sessions
      (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt],
  );

  const cookieStore = await cookies();

  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export async function getSession() {
  // Marca la petición como dinámica: la sesión nunca se prerenderiza ni se cachea.
  await connection();
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  if (!token) {
    return null;
  }

  const tokenHash = hashToken(token);

  const result = await db.query(
    `SELECT
       u.id AS user_id,
       u.username,
       u.first_name,
       u.last_name,
       u.email,
       u.is_active,
       u.must_change_password,
       ur.branch_id,
       r.code AS role_code,
       r.name AS role_name,
       p.code AS permission_code
     FROM farmacia.user_sessions s
     INNER JOIN farmacia.users u
       ON u.id = s.user_id
     LEFT JOIN farmacia.user_roles ur
       ON ur.user_id = u.id
     LEFT JOIN farmacia.roles r
       ON r.id = ur.role_id
     LEFT JOIN farmacia.role_permissions rp
       ON rp.role_id = r.id
     LEFT JOIN farmacia.permissions p
       ON p.id = rp.permission_id
     WHERE s.token_hash = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > NOW()
       AND u.is_active = TRUE`,
    [tokenHash],
  );

  if (result.rows.length === 0) {
    return null;
  }

  const firstRow = result.rows[0];

  const roles = new Map<
    string,
    {
      code: string;
      name: string;
      branchId: string | null;
      permissions: Set<string>;
    }
  >();

  for (const row of result.rows) {
    if (!row.role_code) continue;

    const roleKey = `${row.role_code}:${row.branch_id ?? "global"}`;

    if (!roles.has(roleKey)) {
      roles.set(roleKey, {
        code: row.role_code,
        name: row.role_name,
        branchId: row.branch_id,
        permissions: new Set<string>(),
      });
    }

    if (row.permission_code) {
      roles.get(roleKey)!.permissions.add(row.permission_code);
    }
  }

  return {
    user: {
      id: firstRow.user_id,
      username: firstRow.username,
      firstName: firstRow.first_name,
      lastName: firstRow.last_name,
      email: firstRow.email,
      mustChangePassword: firstRow.must_change_password,
    },
    roles: Array.from(roles.values()).map((role) => ({
      code: role.code,
      name: role.name,
      branchId: role.branchId,
      permissions: Array.from(role.permissions),
    })),
  };
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  if (token) {
    const tokenHash = hashToken(token);

    await db.query(
      `UPDATE farmacia.user_sessions
       SET revoked_at = NOW()
       WHERE token_hash = $1
         AND revoked_at IS NULL`,
      [tokenHash],
    );
  }

  cookieStore.delete(COOKIE_NAME);
}
