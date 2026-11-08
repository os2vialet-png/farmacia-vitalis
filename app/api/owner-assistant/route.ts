import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { clientIp, jsonError } from "@/src/lib/http";
import { isBusinessError, isUniqueViolation } from "@/src/lib/errors";
import { execute, interpret } from "@/src/lib/owner-assistant";

const bodySchema = z.union([
  z.object({ message: z.string().trim().min(1).max(500) }),
  z.object({ execute: z.object({ action: z.string(), params: z.record(z.string(), z.unknown()) }) }),
]);

/**
 * Asistente del dueño (propietario y administradores).
 * { message } interpreta y propone; { execute } ejecuta una propuesta confirmada.
 */
export async function POST(request: NextRequest) {
  try {
    const access = await authorize("users.view");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);

    if (!parsed.success) {
      return jsonError("Escribe una orden (máximo 500 caracteres).", 400);
    }

    if ("message" in parsed.data) {
      const result = await interpret(access.session, parsed.data.message);
      return NextResponse.json({ success: true, ...result });
    }

    const result = await execute(access.session, parsed.data.execute, clientIp(request));
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    if (isBusinessError(error)) return jsonError(error.message, error.status);
    if (isUniqueViolation(error)) return jsonError("Ya existe un registro con esos datos.", 409);
    console.error("Error en asistente del dueño:", error);
    return jsonError("No fue posible completar la orden.", 500);
  }
}
