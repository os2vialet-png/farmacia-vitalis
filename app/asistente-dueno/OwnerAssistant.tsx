"use client";

import { ChangeEvent, FormEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type ApiRequest = { method: "POST"; path: string; body: Record<string, unknown> | null; successText: string };
type Proposal = { action: string; params: Record<string, unknown>; summary: string[]; request?: ApiRequest };

type Message =
  | { role: "user"; text: string; voice?: boolean }
  | { role: "bot"; text: string; bullets?: string[]; proposal?: Proposal; done?: boolean; secret?: string };

const SUGGESTIONS = [
  "avisos",
  "¿qué tengo que pedir?",
  "¿cómo van las ventas de la semana?",
  "¿tenemos winasorb?",
  "pide 5 loratadina de Villa Mella para Santiago",
  "llévame a reportes",
  "deshacer",
];

const YES = /^(si|sí|dale|ok|okay|confirmo|confirma|hazlo|de una|claro|correcto|procede)[.! ]*$/i;
const NO = /^(no|cancela|cancelar|déjalo|dejalo|olvídalo|olvidalo)[.! ]*$/i;

/** **negrita** dentro de una línea (sin HTML: React escapa el texto). */
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : <span key={i}>{part.replace(/(^|\s)\*([^*\s][^*]*)\*/g, "$1$2")}</span>,
  );
}

/** Formato simple de las respuestas de la IA: párrafos, listas con «- » y negritas. */
function RichText({ text }: { text: string }) {
  const blocks: { list: boolean; lines: { text: string; depth: number }[] }[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const bullet = /^(\s*)[-*•]\s+(.*)$/.exec(raw);
    const line = bullet ? bullet[2] : raw.replace(/^#+\s*/, "").trim();
    const depth = bullet && bullet[1].length >= 2 ? 1 : 0;
    const last = blocks[blocks.length - 1];
    if (last && last.list === Boolean(bullet)) last.lines.push({ text: line, depth });
    else blocks.push({ list: Boolean(bullet), lines: [{ text: line, depth }] });
  }
  return (
    <div className="space-y-1.5">
      {blocks.map((block, i) =>
        block.list ? (
          <ul key={i} className="list-disc space-y-0.5 pl-5">
            {block.lines.map((line, j) => <li key={j} className={line.depth ? "ml-4 list-[circle]" : ""}>{inline(line.text)}</li>)}
          </ul>
        ) : (
          block.lines.map((line, j) => <p key={`${i}-${j}`}>{inline(line.text)}</p>)
        ),
      )}
    </div>
  );
}

export default function OwnerAssistant({
  firstName,
  initialReply,
  initialBullets,
  compact = false,
  voiceEnabled = false,
}: {
  firstName: string;
  initialReply: string;
  initialBullets: string[];
  /** Versión reducida para el panel flotante. */
  compact?: boolean;
  /** La IA en la nube está configurada (permite notas de voz). */
  voiceEnabled?: boolean;
}) {
  const router = useRouter();
  const [messages, setMessages] = useState<Message[]>([
    { role: "bot", text: `Hola, ${firstName}. ${initialReply}`, bullets: initialBullets },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [speak, setSpeak] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const fileInput = useRef<HTMLInputElement | null>(null);

  function say(text: string) {
    if (!speak || typeof window === "undefined" || !("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.replace(/[•✔✖⚠⛔*]/g, ""));
    utterance.lang = "es-DO";
    window.speechSynthesis.speak(utterance);
  }

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

  function historyOf(list: Message[]) {
    return list.slice(-12).map((message) => ({
      role: message.role === "user" ? ("user" as const) : ("assistant" as const),
      content: message.role === "bot"
        ? [message.text, ...(message.bullets ?? []), ...(message.proposal ? message.proposal.summary : [])].join("\n")
        : message.text,
    }));
  }

  const pendingIndex = messages.findLastIndex((message) => message.role === "bot" && Boolean(message.proposal) && !message.done);

  async function send(text: string, voice = false) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");

    // «sí» / «no» responden a la propuesta pendiente.
    if (pendingIndex >= 0) {
      const pending = messages[pendingIndex];
      if (pending.role === "bot" && pending.proposal && (YES.test(trimmed) || NO.test(trimmed))) {
        setMessages((current) => [...current, { role: "user", text: trimmed, voice }]);
        if (YES.test(trimmed)) await confirm(pendingIndex, pending.proposal);
        else cancel(pendingIndex);
        return;
      }
    }

    setBusy(true);
    const history = historyOf(messages);
    setMessages((current) => [...current, { role: "user", text: trimmed, voice }]);
    const { ok, data } = await call({ message: trimmed, history });
    const reply = ok
      ? data.understoodAs ? `Entendí: «${String(data.understoodAs)}». ${String(data.reply)}` : String(data.reply)
      : String(data.error ?? "No fue posible responder.");
    setMessages((current) => [
      ...current,
      ok
        ? { role: "bot", text: reply, bullets: data.bullets as string[] | undefined, proposal: data.proposal as Proposal | undefined }
        : { role: "bot", text: reply },
    ]);
    setBusy(false);
    say(reply);
    if (ok && typeof data.navigate === "string" && data.navigate.startsWith("/")) router.push(data.navigate);
  }

  async function confirm(index: number, proposal: Proposal) {
    setBusy(true);
    let result: Message;

    if (proposal.request) {
      // Acción sobre una API del sistema, con los permisos del usuario.
      try {
        const response = await fetch(proposal.request.path, {
          method: proposal.request.method,
          headers: { "Content-Type": "application/json" },
          body: proposal.request.body ? JSON.stringify(proposal.request.body) : undefined,
        });
        const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        result = response.ok
          ? { role: "bot", text: `✔ ${proposal.request.successText}` }
          : { role: "bot", text: `✖ ${String(data.error ?? "No se pudo ejecutar.")}` };
      } catch {
        result = { role: "bot", text: "✖ No se pudo conectar con el servidor." };
      }
    } else {
      const { ok, data } = await call({ execute: { action: proposal.action, params: proposal.params } });
      result = ok
        ? { role: "bot", text: `✔ ${String(data.message)}`, secret: data.temporaryPassword as string | undefined }
        : { role: "bot", text: `✖ ${String(data.error ?? "No se pudo ejecutar.")}` };
    }

    setMessages((current) => [
      ...current.map((message, i) => (i === index && message.role === "bot" ? { ...message, done: true } : message)),
      result,
    ]);
    setBusy(false);
    say(result.text);
    router.refresh();
  }

  function cancel(index: number) {
    setMessages((current) => [
      ...current.map((message, i) => (i === index && message.role === "bot" ? { ...message, done: true } : message)),
      { role: "bot", text: "Cancelado. No se cambió nada." },
    ]);
  }

  async function transcribe(audio: Blob, name: string) {
    setBusy(true);
    try {
      const form = new FormData();
      form.append("audio", audio, name);
      const response = await fetch("/api/owner-assistant/transcribe", { method: "POST", body: form });
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      setBusy(false);
      if (!response.ok) {
        setMessages((current) => [...current, { role: "bot", text: `✖ ${String(data.error ?? "No se pudo transcribir el audio.")}` }]);
        return;
      }
      await send(String(data.text), true);
    } catch {
      setBusy(false);
      setMessages((current) => [...current, { role: "bot", text: "✖ No se pudo enviar el audio." }]);
    }
  }

  async function toggleRecording() {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const media = new MediaRecorder(stream);
      chunks.current = [];
      media.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      media.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const type = media.mimeType || "audio/webm";
        const extension = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        void transcribe(new Blob(chunks.current, { type }), `nota.${extension}`);
      };
      recorder.current = media;
      media.start();
      setRecording(true);
    } catch {
      setMessages((current) => [...current, { role: "bot", text: "No pude usar el micrófono. Revisa el permiso del navegador (en la web debe ser https)." }]);
    }
  }

  function uploadAudio(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void transcribe(file, file.name);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(input);
  }

  return (
    <section className={`flex flex-col bg-white ${compact ? "" : "rounded-xl border border-gray-200 shadow-sm"}`}>
      <div className={`${compact ? "max-h-[48vh] min-h-[240px]" : "max-h-[60vh] min-h-[360px]"} space-y-3 overflow-y-auto p-4`} aria-live="polite">
        {messages.map((message, index) => (
          <div key={index} className={message.role === "user" ? "text-right" : "text-left"}>
            <div className={`inline-block max-w-[92%] rounded-lg px-3 py-2 text-left text-sm ${message.role === "user" ? "bg-green-700 text-white" : "bg-gray-100 text-gray-900"}`}>
              {message.role === "user" && message.voice && <span className="mb-1 block text-[11px] text-white/80">🎤 Nota de voz</span>}
              {message.role === "bot" ? <RichText text={message.text} /> : <p className="whitespace-pre-wrap">{message.text}</p>}
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
                    <div className="mt-3 flex items-center gap-2">
                      <button type="button" disabled={busy} onClick={() => confirm(index, message.proposal as Proposal)} className="rounded-lg bg-[#00A651] px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                        Confirmar
                      </button>
                      <button type="button" disabled={busy} onClick={() => cancel(index)} className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs">
                        Cancelar
                      </button>
                      <span className="text-[11px] text-amber-800">o di «sí» / «no»</span>
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
        {busy && <p className="text-xs text-gray-500">Pensando…</p>}
        {recording && <p className="text-xs font-semibold text-red-600">● Grabando… toca el micrófono otra vez para enviar.</p>}
      </div>

      <div className="flex flex-wrap gap-2 border-t px-3 pt-3">
        {SUGGESTIONS.map((suggestion) => (
          <button key={suggestion} type="button" disabled={busy} onClick={() => void send(suggestion)} className="rounded-full border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50">
            {suggestion}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="flex items-center gap-2 p-3">
        {voiceEnabled && (
          <>
            <button
              type="button"
              onClick={() => void toggleRecording()}
              disabled={busy && !recording}
              aria-label={recording ? "Detener y enviar nota de voz" : "Grabar nota de voz"}
              title={recording ? "Detener y enviar" : "Hablar"}
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${recording ? "animate-pulse bg-red-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"} disabled:opacity-50`}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
              aria-label="Subir un audio"
              title="Subir audio (p. ej. nota de voz de WhatsApp)"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 disabled:opacity-50"
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />
              </svg>
            </button>
            <input ref={fileInput} type="file" accept="audio/*,.ogg,.opus,.m4a,.mp3,.wav,.webm" className="hidden" onChange={uploadAudio} />
          </>
        )}
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          maxLength={1000}
          placeholder={voiceEnabled ? "Escribe o habla: «¿cuánto vendimos hoy?»" : "Ej.: ¿cuánto vendimos hoy?"}
          aria-label="Mensaje para el asistente"
          className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00A651]"
        />
        <button
          type="button"
          onClick={() => setSpeak((value) => !value)}
          aria-pressed={speak}
          title={speak ? "Leer respuestas en voz alta: activado" : "Leer respuestas en voz alta: desactivado"}
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${speak ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-500"}`}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 10v4h4l5 4V6L8 10H4Z" />
            {speak && <path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />}
          </svg>
        </button>
        <button type="submit" disabled={busy || !input.trim()} className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Enviar
        </button>
      </form>
    </section>
  );
}
