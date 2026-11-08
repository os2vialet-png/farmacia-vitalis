import "server-only";

/**
 * Traductor opcional de lenguaje libre a una orden del asistente del dueño, usando un modelo
 * de IA LOCAL y gratuito vía Ollama (https://ollama.com). No envía datos a terceros.
 *
 * Variables de entorno:
 *   OLLAMA_MODEL  modelo instalado, p. ej. "qwen2.5:7b" (si falta, el traductor está apagado)
 *   OLLAMA_URL    por defecto http://127.0.0.1:11434
 *
 * Seguridad: el modelo NO ejecuta nada ni ve la base de datos. Solo devuelve el texto de una
 * orden canónica, que luego pasa por las mismas reglas, permisos y confirmación del usuario.
 */

const SYSTEM_PROMPT = `Eres el traductor de órdenes del sistema de una farmacia dominicana.
Convierte el mensaje del dueño en UNA sola orden con exactamente uno de estos formatos (en español, sin explicar nada):
- avisos
- stock bajo
- por vencer
- ventas de la semana
- cuanto hay de <producto>
- deshacer
- crea un <vendedor|farmaceutico|encargado de inventario|administrador> llamado <Nombre Apellido> en <sucursal>
- desactiva al usuario <usuario>
- agrega el medicamento <nombre> forma <forma> concentracion <concentracion> presentacion <presentacion> unidad <unidad> marca <marca>
- pon el precio de <producto> a <monto> en <sucursal>
- pon el minimo de <producto> a <cantidad> en <sucursal>
- cambia el pie del comprobante a <texto>
- cambia el nombre de la farmacia a <texto>
<producto> es solo el nombre del producto, sin palabras como caja, frasco, unidad o tableta delante. <sucursal> es solo su nombre, sin "sucursal de".
Omite las partes que el mensaje no diga (no inventes nombres, montos ni sucursales).
Si el mensaje no corresponde a ninguna orden, usa "ninguna".
Responde solo JSON: {"orden": "..."}`;

export function llmEnabled(): boolean {
  return Boolean(process.env.OLLAMA_MODEL);
}

export async function translateToCommand(message: string): Promise<string | null> {
  const model = process.env.OLLAMA_MODEL;
  if (!model) return null;

  const baseUrl = (process.env.OLLAMA_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");

  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(45_000),
      body: JSON.stringify({
        model,
        stream: false,
        format: "json",
        // Mantiene el modelo en memoria entre consultas (la primera carga tarda ~10 s).
        keep_alive: "30m",
        options: { temperature: 0 },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: message.slice(0, 500) },
        ],
      }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { message?: { content?: string } };
    const parsed = JSON.parse(data.message?.content ?? "{}") as { orden?: unknown };
    const command = typeof parsed.orden === "string" ? parsed.orden.trim() : "";

    if (!command || command.toLowerCase() === "ninguna" || command.length > 500) return null;
    return command;
  } catch {
    // Ollama apagado, sin modelo o respuesta inválida: el asistente sigue con sus reglas.
    return null;
  }
}
