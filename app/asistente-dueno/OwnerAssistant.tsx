"use client";

import { FormEvent, useState } from "react";

type Proposal = { action: string; params: Record<string, unknown>; summary: string[] };

type Message =
  | { role: "user"; text: string }
  | { role: "bot"; text: string; bullets?: string[]; proposal?: Proposal; done?: boolean; secret?: string };

const SUGGESTIONS = [
  "avisos",
  "crea un vendedor llamado Ana Gómez",
  "agrega el medicamento Amoxil forma cápsula concentración 500 mg unidad caja",
  "pon el precio de amoxil a 150",
  "ayuda",
];

export default function OwnerAssistant({ firstName }: { firstName: string }) {
  const [messages, setMessages] = useState<Message[]>([
    { role: "bot", text: `Hola, ${firstName}. Escribe «avisos» para ver el resumen del negocio o «ayuda» para ver lo que puedo hacer.` },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function call(body: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    try {
      const response = await fetch("/api/owner-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { ok: response.ok, data: await response.json() };
    } catch {
      return { ok: false, data: { error: "No se pudo conectar con el servidor." } };
    }
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");
    setBusy(true);
    setMessages((current) => [...current, { role: "user", text: trimmed }]);
    const { ok, data } = await call({ message: trimmed });
    setMessages((current) => [
      ...current,
      ok
        ? { role: "bot", text: String(data.reply), bullets: data.bullets as string[] | undefined, proposal: data.proposal as Proposal | undefined }
        : { role: "bot", text: String(data.error ?? "No fue posible responder.") },
    ]);
    setBusy(false);
  }

  async function confirm(index: number, proposal: Proposal) {
    setBusy(true);
    const { ok, data } = await call({ execute: { action: proposal.action, params: proposal.params } });
    setMessages((current) => [
      ...current.map((message, i) => (i === index && message.role === "bot" ? { ...message, done: true } : message)),
      ok
        ? { role: "bot", text: `✔ ${String(data.message)}`, secret: data.temporaryPassword as string | undefined }
        : { role: "bot", text: `✖ ${String(data.error ?? "No se pudo ejecutar.")}` },
    ]);
    setBusy(false);
  }

  function cancel(index: number) {
    setMessages((current) => [
      ...current.map((message, i) => (i === index && message.role === "bot" ? { ...message, done: true } : message)),
      { role: "bot", text: "Cancelado. No se cambió nada." },
    ]);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(input);
  }

  return (
    <section className="flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="max-h-[60vh] min-h-[360px] space-y-3 overflow-y-auto p-4" aria-live="polite">
        {messages.map((message, index) => (
          <div key={index} className={message.role === "user" ? "text-right" : "text-left"}>
            <div className={`inline-block max-w-[92%] rounded-lg px-3 py-2 text-left text-sm ${message.role === "user" ? "bg-green-700 text-white" : "bg-gray-100 text-gray-900"}`}>
              <p>{message.text}</p>
              {message.role === "bot" && message.bullets && (
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  {message.bullets.map((bullet, i) => <li key={i}>{bullet}</li>)}
                </ul>
              )}
              {message.role === "bot" && message.proposal && (
                <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
                  <ul className="list-disc space-y-1 pl-5 text-amber-900">
                    {message.proposal.summary.map((line, i) => <li key={i}>{line}</li>)}
                  </ul>
                  {!message.done && (
                    <div className="mt-3 flex gap-2">
                      <button type="button" disabled={busy} onClick={() => confirm(index, message.proposal as Proposal)} className="rounded-lg bg-[#00A651] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                        Confirmar
                      </button>
                      <button type="button" disabled={busy} onClick={() => cancel(index)} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs">
                        Cancelar
                      </button>
                    </div>
                  )}
                </div>
              )}
              {message.role === "bot" && message.secret && (
                <div className="mt-2 rounded-lg border border-green-300 bg-white p-2">
                  <p className="text-xs text-gray-600">Contraseña temporal (solo se muestra ahora):</p>
                  <code className="break-all font-mono text-sm">{message.secret}</code>
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && <p className="text-xs text-gray-500">Procesando…</p>}
      </div>

      <div className="flex flex-wrap gap-2 border-t px-3 pt-3">
        {SUGGESTIONS.map((suggestion) => (
          <button key={suggestion} type="button" disabled={busy} onClick={() => void send(suggestion)} className="rounded-full border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50">
            {suggestion}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="flex gap-2 p-3">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          maxLength={500}
          placeholder="Ej.: crea un farmacéutico llamado Luis Peña en Villa Mella"
          aria-label="Orden para el asistente"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00A651]"
        />
        <button type="submit" disabled={busy || !input.trim()} className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Enviar
        </button>
      </form>
    </section>
  );
}
