import "server-only";

import { isIP } from "node:net";
import { NextResponse } from "next/server";

/** Respuesta de error uniforme para las APIs. No incluye detalles internos. */
export function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ success: false, error: message, ...extra }, { status });
}

/**
 * IP del cliente tomada de cabeceras de proxy. Devuelve null si no es una IP válida.
 * Si el sistema se expone directamente a Internet, estas cabeceras pueden falsificarse:
 * por eso el límite de intentos de login también aplica por usuario, no solo por IP.
 */
export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || request.headers.get("x-real-ip")?.trim() || null;

  return candidate && isIP(candidate) ? candidate : null;
}
