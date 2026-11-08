import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { db } from "@/src/lib/db";
import { answer, allowRequest } from "@/src/lib/assistant";
import { writeAudit } from "@/src/lib/audit";
import { jsonError } from "@/src/lib/http";

/**
 * Integración con WhatsApp Cloud API (Meta). Está PREPARADA pero no se activa sin credenciales.
 *
 * Variables de entorno (solo nombres; nunca se muestran sus valores):
 * - WHATSAPP_VERIFY_TOKEN: token que se escribe al registrar el webhook en Meta.
 * - WHATSAPP_APP_SECRET: secreto de la app, para validar la firma de cada entrega.
 * - WHATSAPP_ACCESS_TOKEN y WHATSAPP_PHONE_NUMBER_ID: para enviar respuestas.
 *
 * Sin WHATSAPP_ACCESS_TOKEN y WHATSAPP_PHONE_NUMBER_ID, el webhook procesa y registra las
 * consultas pero NO envía respuestas ni hace llamadas externas.
 * Meta cobra por conversación; activar el envío requiere autorización del propietario.
 */

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const received = header.slice("sha256=".length);

  if (received.length !== expected.length) return false;

  return timingSafeEqual(Buffer.from(received, "utf8"), Buffer.from(expected, "utf8"));
}

/** Verificación del webhook que hace Meta al registrarlo. */
export async function GET(request: NextRequest) {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  if (!verifyToken) {
    return jsonError("El webhook de WhatsApp no está configurado.", 503);
  }

  const mode = request.nextUrl.searchParams.get("hub.mode");
  const token = request.nextUrl.searchParams.get("hub.verify_token");
  const challenge = request.nextUrl.searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === verifyToken && challenge) {
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }

  return jsonError("Verificación rechazada.", 403);
}

async function sendText(to: string, text: string): Promise<boolean> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneId) return false;

  const response = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text.slice(0, 4000) },
    }),
  });

  return response.ok;
}

type IncomingMessage = { from?: string; type?: string; text?: { body?: string } };

/** Entregas de mensajes. Responde 200 rápido y procesa cada mensaje de texto. */
export async function POST(request: NextRequest) {
  const secret = process.env.WHATSAPP_APP_SECRET;

  if (!secret) {
    return jsonError("El webhook de WhatsApp no está configurado.", 503);
  }

  const rawBody = await request.text();

  if (!verifySignature(rawBody, request.headers.get("x-hub-signature-256"), secret)) {
    return jsonError("Firma no válida.", 401);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonError("Cuerpo no válido.", 400);
  }

  const messages: IncomingMessage[] = [];
  const entries = (payload as { entry?: Array<{ changes?: Array<{ value?: { messages?: IncomingMessage[] } }> }> }).entry ?? [];

  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      messages.push(...(change.value?.messages ?? []));
    }
  }

  let processed = 0;
  let delivered = 0;

  for (const message of messages.slice(0, 20)) {
    if (message.type !== "text" || !message.from || !message.text?.body) continue;

    // Límite por remitente: evita abuso del canal sin guardar el número.
    if (!(await allowRequest(`wa:${message.from}`, 15, 60_000))) continue;

    const result = await answer(message.text.body);
    processed += 1;

    await writeAudit(db, {
      actorUserId: null,
      action: "assistant.whatsapp_query",
      entity: "assistant",
      newValues: { intent: result.intent, productsReturned: result.products.length },
    });

    try {
      if (await sendText(message.from, result.reply)) delivered += 1;
    } catch (error) {
      console.error("Error enviando respuesta de WhatsApp:", error);
    }
  }

  return NextResponse.json({ success: true, processed, delivered });
}
