import { NextRequest, NextResponse } from "next/server";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { jsonError } from "@/src/lib/http";
import { allowRequest } from "@/src/lib/assistant";
import { cloudAiEnabled, transcribeAudio } from "@/src/lib/ai-client";

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = /^audio\/|^video\/webm|^video\/mp4|^application\/ogg/;

/** Convierte una nota de voz (grabada o subida, p. ej. de WhatsApp) en texto. El audio no se guarda. */
export async function POST(request: NextRequest) {
  try {
    const access = await authorize("users.view");
    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    if (!cloudAiEnabled()) {
      return jsonError("Para entender audios falta configurar la IA en la nube (AI_API_KEY). Ver docs/IA.md.", 503);
    }

    if (!(await allowRequest(`owner-transcribe:${access.session.user.id}`, 15))) {
      return jsonError("Demasiados audios seguidos. Espera un minuto.", 429);
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get("audio");
    if (!(file instanceof Blob) || file.size === 0) return jsonError("No llegó ningún audio.", 400);
    if (file.size > MAX_BYTES) return jsonError("El audio es muy grande (máximo 15 MB).", 413);
    if (file.type && !ALLOWED.test(file.type)) return jsonError("Formato de audio no admitido.", 415);

    const name = file instanceof File && file.name ? file.name : "nota.webm";
    const text = await transcribeAudio(file, name);
    if (!text) return jsonError("No se entendió el audio. Intenta hablar más cerca del micrófono.", 422);

    return NextResponse.json({ success: true, text });
  } catch (error) {
    console.error("Error transcribiendo audio:", error instanceof Error ? error.message : "error");
    return jsonError("No fue posible transcribir el audio.", 502);
  }
}
