
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";

import { db } from "@/src/lib/db";
import { authorize } from "@/src/lib/auth/permissions";
import { hashPassword } from "@/src/lib/auth/password";

const createUserSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[a-zA-Z0-9._-]+$/),

  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),

  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .optional()
    .or(z.literal("")),

  phone: z.string().trim().max(30).optional().or(z.literal("")),

  branchId: z.string().uuid(),

  roleCode: z.enum([
    "admin",
    "pharmacist",
    "inventory_manager",
    "seller",
  ]),
});

export async function GET() {
  try {
    const access = await authorize("users.view");

    if (!access.authorized) {
      return NextResponse.json(
        { error: "No tienes autorización para consultar usuarios." },
        {
          status:
            access.reason === "unauthenticated" ? 401 : 403,
        },
      );
    }

    const isOwner = access.session.roles.some(
      (role) => role.code === "owner",
    );

    if (!isOwner) {
      return NextResponse.json(
        { error: "Solo el propietario puede consultar el listado completo." },
        { status: 403 },
      );
    }

    const result = await db.query(
      `SELECT
         u.id,
         u.username,
         u.email,
         u.first_name,
         u.last_name,
         u.phone,
         u.is_active,
         u.must_change_password,
         u.last_login_at,
         u.created_at,
         COALESCE(
           jsonb_agg(
             DISTINCT jsonb_build_object(
               'code', r.code,
               'name', r.name,
               'branchId', ur.branch_id,
               'branchName', b.name
             )
           ) FILTER (WHERE r.id IS NOT NULL),
           '[]'::jsonb
         ) AS roles
       FROM farmacia.users u
       LEFT JOIN farmacia.user_roles ur ON ur.user_id = u.id
       LEFT JOIN farmacia.roles r ON r.id = ur.role_id
       LEFT JOIN farmacia.branches b ON b.id = ur.branch_id
       GROUP BY u.id
       ORDER BY u.created_at DESC`,
    );

    return NextResponse.json({
      success: true,
      total: result.rows.length,
      users: result.rows,
    });
  } catch (error) {
    console.error("Error consultando usuarios:", error);

    return NextResponse.json(
      { error: "No fue posible consultar los usuarios." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let client;

  try {
    const access = await authorize("users.manage");

    if (!access.authorized) {
      return NextResponse.json(
        { error: "No tienes autorización para crear usuarios." },
        {
          status:
            access.reason === "unauthenticated" ? 401 : 403,
        },
      );
    }

    const isOwner = access.session.roles.some(
      (role) => role.code === "owner",
    );

    if (!isOwner) {
      return NextResponse.json(
        { error: "Solo el propietario puede crear empleados." },
        { status: 403 },
      );
    }

    const body: unknown = await request.json().catch(() => null);
    const validation = createUserSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          error: "Datos inválidos.",
          details: validation.error.issues.map((issue) => ({
            field: issue.path.join("."),
            message: issue.message,
          })),
        },
        { status: 400 },
      );
    }

    const data = validation.data;

    const username = data.username.trim();
    const firstName = data.firstName.trim();
    const lastName = data.lastName.trim();
    const email = data.email ? data.email.toLowerCase() : null;
    const phone = data.phone || null;

    const temporaryPassword = randomBytes(24).toString("base64url");
    const passwordHash = await hashPassword(temporaryPassword);

    client = await db.connect();

    await client.query("BEGIN");

    const branchResult = await client.query(
      `SELECT id
       FROM farmacia.branches
       WHERE id = $1
         AND is_active = TRUE
       FOR SHARE`,
      [data.branchId],
    );

    if (branchResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return NextResponse.json(
        { error: "La sucursal no existe o está inactiva." },
        { status: 400 },
      );
    }

    const roleResult = await client.query(
      `SELECT id, code
       FROM farmacia.roles
       WHERE code = $1
       FOR SHARE`,
      [data.roleCode],
    );

    if (roleResult.rows.length === 0) {
      await client.query("ROLLBACK");

      return NextResponse.json(
        { error: "El rol seleccionado no existe." },
        { status: 400 },
      );
    }

    const userResult = await client.query(
      `INSERT INTO farmacia.users (
         username,
         email,
         password_hash,
         first_name,
         last_name,
         phone,
         is_active,
         must_change_password
       )
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, TRUE)
       RETURNING
         id,
         username,
         first_name,
         last_name`,
      [
        username,
        email,
        passwordHash,
        firstName,
        lastName,
        phone,
      ],
    );

    const newUser = userResult.rows[0];
    const role = roleResult.rows[0];

    await client.query(
      `INSERT INTO farmacia.user_roles (
         user_id,
         role_id,
         branch_id
       )
       VALUES ($1, $2, $3)`,
      [newUser.id, role.id, data.branchId],
    );

    await client.query(
      `INSERT INTO farmacia.audit_logs (
         actor_user_id,
         branch_id,
         action,
         entity,
         entity_id,
         new_values
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        access.session.user.id,
        data.branchId,
        "create",
        "user",
        newUser.id,
        JSON.stringify({
          username: newUser.username,
          firstName: newUser.first_name,
          lastName: newUser.last_name,
          role: role.code,
          branchId: data.branchId,
        }),
      ],
    );

    await client.query("COMMIT");

    return NextResponse.json(
      {
        success: true,
        message: "Empleado creado correctamente.",
        user: newUser,
        temporaryPassword,
        mustChangePassword: true,
      },
      { status: 201 },
    );
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }

    const databaseError = error as { code?: string };

    if (databaseError.code === "23505") {
      return NextResponse.json(
        {
          error: "El nombre de usuario o correo electrónico ya está registrado.",
        },
        { status: 409 },
      );
    }

    console.error("Error creando empleado:", error);

    return NextResponse.json(
      { error: "No fue posible crear el empleado." },
      { status: 500 },
    );
  } finally {
    client?.release();
  }
}

