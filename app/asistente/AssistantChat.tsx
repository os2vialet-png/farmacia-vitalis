"use client";

import { FormEvent, useState } from "react";

type Product = {
  name: string;
  presentation: string | null;
  saleUnit: string;
  price: string | null;
  available: boolean;
  requiresPrescription: boolean;
};

type Message =
  | { role: "bot"; text: string; products?: Product[] }
  | { role: "user"; text: string };

const WELCOME: Message = {
  role: "bot",
  text: "Hola, soy el asistente de Farmacia Vitalis. Escribe el nombre de un producto para consultar disponibilidad y precio.",
};

export default function AssistantChat() {
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = input.trim();
    if (!text || busy) return;

    setInput("");
    setMessages((current) => [...current, { role: "user", text }]);
    setBusy(true);

    try {
      const response = await fetch("/api/assistant/web", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await response.json();

      const reply: Message = response.ok
        ? { role: "bot", text: data.reply, products: data.products }
        : { role: "bot", text: data.error || "No fue posible responder. Intenta de nuevo." };

      setMessages((current) => [...current, reply]);
    } catch {
      setMessages((current) => [
        ...current,
        { role: "bot", text: "No se pudo conectar. Revisa tu conexión e intenta de nuevo." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="max-h-[60vh] min-h-[320px] space-y-3 overflow-y-auto p-4" aria-live="polite">
        {messages.map((message, index) => (
          <div key={index} className={message.role === "user" ? "text-right" : "text-left"}>
            <div
              className={`inline-block max-w-[90%] rounded-lg px-3 py-2 text-sm ${
                message.role === "user" ? "bg-green-700 text-white" : "bg-gray-100 text-gray-900"
              }`}
            >
              {message.text}
            </div>
            {message.role === "bot" && message.products && message.products.length > 0 && (
              <ul className="mt-2 space-y-2">
                {message.products.map((product, productIndex) => (
                  <li key={productIndex} className="rounded-lg border border-gray-200 p-3 text-left text-xs">
                    <p className="text-sm font-semibold text-gray-900">{product.name}</p>
                    <p className="text-gray-600">
                      {[product.presentation, `Unidad: ${product.saleUnit}`].filter(Boolean).join(" · ")}
                    </p>
                    <p className="mt-1">
                      <span className={product.available ? "text-green-700" : "text-red-700"}>
                        {product.available ? "Disponible" : "No disponible por ahora"}
                      </span>
                      {product.price ? ` · ${product.price}` : " · Precio: consulta en la sucursal"}
                      {product.requiresPrescription ? " · Requiere receta" : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        {busy && <p className="text-xs text-gray-500">Consultando...</p>}
      </div>

      <form onSubmit={send} className="flex gap-2 border-t p-3">
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          maxLength={300}
          placeholder="Ej.: ¿Tienen amoxicilina 500?"
          aria-label="Escribe tu consulta"
          className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-[#00A651]"
        />
        <button type="submit" disabled={busy || input.trim().length === 0} className="rounded-lg bg-[#00A651] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
          Enviar
        </button>
      </form>
    </section>
  );
}
