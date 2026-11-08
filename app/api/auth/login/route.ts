import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { burnPasswordTime, verifyPassword } from "@/src/lib/auth/password";
import { createSession } from "@/src/lib/auth/session";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";

const INVALID_CREDENTIALS = "Usuario o contraseña incorrectos.";

/**
 * Política de límites (ventana de 15 minutos, solo cuentan los fallos):
 * - 5 fallos para el mismo usuario desde la misma IP.
 * - 10 fallos para el usuario cuando no se puede determinar la IP.
 * - 30 fallos para el usuario desde cualquier IP (frena ataques con IP falsificada).
 * - 50 fallos desde una misma IP contra cualquier usuario.
 * El bloqueo siempre es temporal: el propietario nunca queda fuera de forma permanente
 * (se puede restablecer con scripts/reset-owner-password.ts).
 */
const WINDOW_MINUTES = 15;
const LIMIT_USER_AND_IP = 5;
const LIMIT_USER_UNKNOWN_IP = 10;
const LIMIT_USER_ANY_IP = 30;
const LIMIT_IP_ANY_USER = 50;

const loginSchema = z.object({
  username: z.string().trim().min(1).max(60),
  password: z.string().min(1).max(128),
});

type Counters = { by_user: number; by_user_ip: number; by_ip: number };

async function countRecentFailures(username: string, ip: string | null): Promise<Counters> {
  const result = await db.query<Counters>(
    `SELECT
       COUNT(*) FILTER (WHERE new_values->>'username' = $1)::int AS by_user,
       COUNT(*) FILTER (WHERE new_values->>'username' = $1 AND ip_address = $2::inet)::int AS by_user_ip,
       COUNT(*) FILTER (WHERE ip_address = $2::inet)::int AS by_ip
     FROM farmacia.audit_logs
     WHERE action = 'login_failed'
       AND created_at > NOW() - make_interval(mins => $3::int)`,
    [username, ip, WINDOW_MINUTES],
  );

  return result.rows[0];
}

function isLocked(counters: Counters, ip: string | null): boolean {
  if (counters.by_user >= LIMIT_USER_ANY_IP) return true;
  if (ip === null && counters.by_user >= LIMIT_USER_UNKNOWN_IP) return true;
  if (ip !== null && counters.by_user_ip >= LIMIT_USER_AND_IP) return true;
  if (ip !== null && counters.by_ip >= LIMIT_IP_ANY_USER) return true;
  return false;
}

async function recordFailure(username: string, ip: string | null): Promise<void> {
  await writeAudit(db, {
    actorUserId: null,
    action: "login_failed",
    entity: "user",
    newValues: { username },
    ip,
  });
}

export async function POST(request: NextRequest) {
  try {
    const body: unknown = await request.json().catch(() => null);
    const validation = loginSchema.safeParse(body);

    if (!validation.success) {
      return jsonError(INVALID_CREDENTIALS, 400);
    }

    const { password } = validation.data;
    const username = validation.data.username.toLowerCase();
    const ip = clientIp(request);

    const counters = await countRecentFailures(username, ip);

    if (isLocked(counters, ip)) {
      return jsonError(
        `Demasiados intentos fallidos. Espera ${WINDOW_MINUTES} minutos antes de volver a intentar.`,
        429,
      );
    }

    const result = await db.query(
      `SELECT id, username, password_hash, is_active, must_change_password
       FROM farmacia.users
       WHERE LOWER(username) = $1
       LIMIT 1`,
      [username],
    );

    const user = result.rows[0];

    // Siempre se ejecuta scrypt, aunque el usuario no exista o esté inactivo,
    // para que el tiempo de respuesta no revele si el nombre existe.
    if (!user || !user.is_active) {
      await burnPasswordTime(password);
      await recordFailure(username, ip);
      return jsonError(INVALID_CREDENTIALS, 401);
    }

    const passwordIsValid = await verifyPassword(password, user.password_hash);

    if (!passwordIsValid) {
      await recordFailure(username, ip);
      return jsonError(INVALID_CREDENTIALS, 401);
    }

    await createSession(user.id);

    await db.query(
      `UPDATE farmacia.users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [user.id],
    );

    await writeAudit(db, {
      actorUserId: user.id,
      action: "login",
      entity: "user",
      entityId: user.id,
      newValues: { username: user.username, mustChangePassword: user.must_change_password },
      ip,
    });

    return NextResponse.json({
      success: true,
      message: "Inicio de sesión exitoso.",
      mustChangePassword: user.must_change_password === true,
      redirectTo: user.must_change_password ? "/cambiar-contrasena" : "/dashboard",
    });
  } catch (error) {
    console.error("Error en inicio de sesión:", error);

    return jsonError("No fue posible iniciar sesión. Inténtalo nuevamente.", 500);
  }
}
