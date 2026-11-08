import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { answer, allowRequest, MAX_MESSAGE_LENGTH } from "@/src/lib/assistant";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";

const bodySchema = z.object({
  message: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
});

/** Asistente web público. No requiere sesión; solo muestra catálogo verificado y disponibilidad sí/no. */
export async function POST(request: NextRequest) {
  try {
    const ip = clientIp(request);
    const key = `web:${ip ?? "unknown"}`;

    if (!(await allowRequest(key, 20, 60_000))) {
      return jsonError("Hay muchas consultas seguidas. Espera un minuto e intenta de nuevo.", 429);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = bodySchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(`Escribe tu consulta (máximo ${MAX_MESSAGE_LENGTH} caracteres).`, 400);
    }

    const result = await answer(parsed.data.message);

    await writeAudit(db, {
      actorUserId: null,
      action: "assistant.web_query",
      entity: "assistant",
      newValues: { intent: result.intent, productsReturned: result.products.length },
      ip,
    });

    return NextResponse.json({
      success: true,
      intent: result.intent,
      reply: result.reply,
      products: result.products,
    });
  } catch (error) {
    console.error("Error en asistente web:", error);
    return jsonError("El asistente no está disponible en este momento. Intenta más tarde.", 500);
  }
}
