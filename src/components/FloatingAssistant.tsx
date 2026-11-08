"use client";

import Link from "next/link";
import { useState } from "react";
import OwnerAssistant from "@/app/asistente-dueno/OwnerAssistant";

type Greeting = { reply: string; bullets: string[] };

/**
 * Botón flotante (abajo a la derecha) que abre el asistente del dueño en un panel.
 * Al abrirlo por primera vez carga los avisos del negocio.
 */
export default function FloatingAssistant({ firstName, voiceEnabled = false }: { firstName: string; voiceEnabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [greeting, setGreeting] = useState<Greeting | null>(null);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (greeting) return;

    setLoading(true);
    try {
      const response = await fetch("/api/owner-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "avisos" }),
      });
      const data = await response.json();
      setGreeting(
        response.ok
          ? { reply: String(data.reply), bullets: (data.bullets as string[]) ?? [] }
          : { reply: "Escribe «avisos» para ver el resumen o «ayuda» para ver lo que puedo hacer.", bullets: [] },
      );
    } catch {
      setGreeting({ reply: "No se pudieron cargar los avisos. Escribe «avisos» para reintentar.", bullets: [] });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="print:hidden">
      {open && (
        <div
          role="dialog"
          aria-label="Asistente del dueño"
          className="fixed bottom-24 right-4 z-50 flex w-[calc(100vw-2rem)] max-w-[400px] flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl sm:right-6"
        >
          <div className="flex items-center justify-between bg-[#00A651] px-4 py-3 text-white">
            <div>
              <p className="text-sm font-semibold">Asistente del dueño</p>
              <p className="text-xs text-white/80">Confirma antes de cambiar · «deshacer» revierte</p>
            </div>
            <div className="flex items-center gap-3">
              <Link href="/asistente-dueno" className="text-xs underline">Pantalla completa</Link>
              <button type="button" onClick={() => setOpen(false)} aria-label="Cerrar asistente" className="text-lg leading-none">×</button>
            </div>
          </div>
          {loading || !greeting ? (
            <p className="p-6 text-sm text-gray-500">Revisando el negocio…</p>
          ) : (
            <OwnerAssistant firstName={firstName} initialReply={greeting.reply} initialBullets={greeting.bullets} compact voiceEnabled={voiceEnabled} />
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => void toggle()}
        aria-label={open ? "Cerrar asistente del dueño" : "Abrir asistente del dueño"}
        aria-expanded={open}
        className="fixed bottom-5 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-[#00A651] text-white shadow-lg ring-4 ring-white transition hover:scale-105 hover:bg-[#008f45] sm:right-6"
      >
        {open ? (
          <span className="text-2xl leading-none" aria-hidden="true">×</span>
        ) : (
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3Zm6 11 .9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14Z" />
          </svg>
        )}
      </button>
    </div>
  );
}
