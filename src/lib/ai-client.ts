import "server-only";
import { setDefaultResultOrder } from "node:dns";

// Algunas redes (como la de esta farmacia) cortan las conexiones IPv6 hacia la API: se prefiere IPv4.
setDefaultResultOrder("ipv4first");

/**
 * Cliente de IA en la nube con formato compatible con OpenAI (chat con herramientas y
 * transcripción de audio). Por defecto usa Groq, que tiene un plan GRATUITO
 * (https://console.groq.com/keys) y no usa los datos de la API para entrenar modelos.
 * Sirve igual con otro proveedor compatible cambiando AI_BASE_URL y AI_MODEL.
 *
 * Variables de entorno:
 *   AI_API_KEY             clave del proveedor (sin ella, el asistente usa IA local o reglas)
 *   AI_BASE_URL            por defecto https://api.groq.com/openai/v1
 *   AI_MODEL               por defecto openai/gpt-oss-120b
 *   AI_FALLBACK_MODELS     modelos de reserva separados por coma (cada uno tiene su propio cupo gratuito)
 *   AI_TRANSCRIBE_MODEL    por defecto whisper-large-v3-turbo
 *   AI_TIMEOUT_MS          tiempo máximo por consulta, por defecto 30000
 */

const DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_MODEL = "openai/gpt-oss-120b";
const DEFAULT_FALLBACK_MODELS = "openai/gpt-oss-20b,qwen/qwen3.8-27b";
const DEFAULT_TRANSCRIBE_MODEL = "whisper-large-v3-turbo";

export function cloudAiEnabled(): boolean {
  return Boolean(process.env.AI_API_KEY?.trim());
}

function baseUrl(): string {
  return (process.env.AI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function authHeader(): Record<string, string> {
  return { Authorization: `Bearer ${process.env.AI_API_KEY?.trim() ?? ""}` };
}

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export class AiError extends Error {}

/** Se alcanzó el límite gratuito de todos los modelos configurados. */
export class AiRateLimitError extends AiError {
  constructor(public readonly retrySeconds: number) {
    super("Límite de uso del servicio de IA.");
  }
}

/** Modelos a usar en orden: si uno llega a su límite por minuto, se pasa al siguiente (cada uno tiene su cupo). */
function models(): string[] {
  const main = process.env.AI_MODEL?.trim() || DEFAULT_MODEL;
  const fallback = (process.env.AI_FALLBACK_MODELS ?? (process.env.AI_MODEL ? "" : DEFAULT_FALLBACK_MODELS))
    .split(",").map((model) => model.trim()).filter(Boolean);
  return Array.from(new Set([main, ...fallback]));
}

/** Hasta cuándo cada modelo está en su límite (en memoria del servidor). */
const coolingUntil = new Map<string, { until: number; reason: "limit" | "down" }>();

function parseSeconds(value: string | null): number | null {
  if (!value) return null;
  const match = /^(?:(\d+)m)?([\d.]+)(ms|s)?$/.exec(value.trim());
  if (!match) return Number.isFinite(Number(value)) ? Number(value) : null;
  const minutes = Number(match[1] ?? 0);
  const amount = Number(match[2]);
  return minutes * 60 + (match[3] === "ms" ? amount / 1000 : amount);
}

/** Una vuelta de chat. Devuelve el mensaje del asistente (texto o llamadas a herramientas). */
export async function chatCompletion(
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<{ content: string | null; toolCalls: ToolCall[] }> {
  let waitSeconds = 60;
  let limited = false;
  let unavailable = false;

  for (const model of models()) {
    const cooling = coolingUntil.get(model);
    if (cooling && cooling.until > Date.now()) {
      if (cooling.reason === "limit") {
        waitSeconds = Math.min(waitSeconds, Math.ceil((cooling.until - Date.now()) / 1000));
        limited = true;
      } else {
        unavailable = true;
      }
      continue;
    }

    const response = await fetch(`${baseUrl()}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      signal: AbortSignal.timeout(Number(process.env.AI_TIMEOUT_MS) || 30_000),
      body: JSON.stringify({
        model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: 1200,
        // Los modelos gpt-oss razonan antes de responder: «low» ahorra cupo y tiempo.
        ...(model.includes("gpt-oss") ? { reasoning_effort: "low" } : {}),
      }),
    });

    if (response.status === 429) {
      const seconds = parseSeconds(response.headers.get("retry-after"))
        ?? parseSeconds(response.headers.get("x-ratelimit-reset-tokens"))
        ?? 30;
      coolingUntil.set(model, { until: Date.now() + seconds * 1000, reason: "limit" });
      waitSeconds = Math.min(waitSeconds, Math.ceil(seconds));
      limited = true;
      continue;
    }

    if (response.status >= 500) {
      // Modelo saturado o caído: se prueba el siguiente y se evita este unos segundos.
      coolingUntil.set(model, { until: Date.now() + 15_000, reason: "down" });
      unavailable = true;
      continue;
    }

    if (!response.ok) {
      // No se registra el cuerpo: podría incluir datos del negocio.
      throw new AiError(`El servicio de IA respondió ${response.status} (${model}).`);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    };
    const message = data.choices?.[0]?.message;
    // Algunos modelos incluyen su razonamiento entre <think>…</think>: no se muestra.
    const content = message?.content?.replace(/<think>[\s\S]*?<\/think>/g, "").trim() || null;
    return { content, toolCalls: message?.tool_calls ?? [] };
  }

  // Solo fallas del servicio (sin límites de uso): el asistente sigue con sus reglas.
  if (unavailable && !limited) throw new AiError("El servicio de IA no está disponible.");
  throw new AiRateLimitError(Math.max(1, waitSeconds));
}

/** Transcribe una nota de voz (español). */
export async function transcribeAudio(audio: Blob, fileName: string): Promise<string> {
  const form = new FormData();
  form.append("file", audio, fileName);
  form.append("model", process.env.AI_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL);
  form.append("language", "es");
  form.append("response_format", "json");
  form.append("prompt", "Farmacia Vitalis, República Dominicana. Paracetamol, acetaminofén, amoxicilina, loratadina, ibuprofeno, Winasorb, Villa Mella, Santiago, inventario, transferencia, precio en pesos.");

  const response = await fetch(`${baseUrl()}/audio/transcriptions`, {
    method: "POST",
    headers: authHeader(),
    signal: AbortSignal.timeout(60_000),
    body: form,
  });

  if (!response.ok) throw new AiError(`El servicio de transcripción respondió ${response.status}.`);
  const data = (await response.json()) as { text?: string };
  return (data.text ?? "").trim();
}
