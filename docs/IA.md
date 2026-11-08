# Asistente con IA: cómo activarlo (gratis)

El asistente del dueño (botón verde abajo a la derecha y la pantalla «Asistente del dueño") funciona en tres niveles:

| Nivel | Qué necesita | Qué hace |
|---|---|---|
| **IA en la nube** (recomendado) | `AI_API_KEY` | Entiende frases libres, errores de escritura, el contexto («¿y acetaminofén?»), **notas de voz** y controla casi todo el sistema. Funciona igual cuando el sistema esté publicado en la web. |
| IA local (Ollama) | `OLLAMA_MODEL` | Solo en esta computadora, lenta sin tarjeta gráfica. Traduce frases a órdenes básicas. Sin voz. |
| Reglas | nada | Solo órdenes exactas («avisos», «stock bajo», «pon el precio de X a 100 en Villa Mella»). |

## 1. Sacar la clave gratuita (Groq, 3 minutos)

1. Entra a <https://console.groq.com> y crea una cuenta. Puedes entrar con Google, y no pide tarjeta.
2. Ve a **API Keys** → **Create API Key** y ponle de nombre «Farmacia Vitalis».
3. Copia la clave, que empieza con `gsk_`. **No la compartas ni la subas a GitHub.**

El plan gratuito permite unas 30 consultas por minuto y miles al día, más que suficiente para la farmacia. Groq no usa los datos enviados por la API para entrenar modelos.

## 2. Ponerla en el sistema

Abre el archivo `.env.local`, en la carpeta del proyecto, y agrega esta línea:

```
AI_API_KEY=gsk_tu_clave_aqui
```

Reinicia el sistema: detén `npm run start` con Ctrl+C y vuelve a ejecutarlo. En la pantalla «Asistente del dueño» verás «IA en la nube activa» y aparecerá el botón del micrófono.

Variables opcionales, para cambiar de proveedor o de modelo:

```
AI_BASE_URL=https://api.groq.com/openai/v1   # cualquier API compatible con OpenAI
AI_MODEL=openai/gpt-oss-120b
AI_FALLBACK_MODELS=openai/gpt-oss-20b,qwen/qwen3.8-27b   # si uno llega a su límite, usa el siguiente
AI_TRANSCRIBE_MODEL=whisper-large-v3-turbo
```

El plan gratuito da a cada modelo unos 8.000 tokens por minuto y 1.000 consultas al día. Como cada modelo tiene su propio cupo, el sistema pasa al siguiente cuando uno se llena. Si se llenan todos, el asistente pide esperar unos segundos.

La red de esta farmacia corta las conexiones por IPv6 hacia Groq, así que el sistema usa IPv4 automáticamente.

Si algún día quieres un modelo de pago, por ejemplo OpenAI, solo cambias esas tres variables. El código no cambia.

## 3. Qué le puedes pedir

Por texto o por voz (botón del micrófono), o subiendo un audio, por ejemplo una nota de voz de WhatsApp:

- **Consultas:** «¿tenemos winasorb ultra?», «¿y acetaminofén?», «¿cuánto vendimos esta semana y qué fue lo más vendido?», «últimas ventas», «¿qué tengo que pedir?», «¿se me vence algo?», «busca al cliente Pérez», «¿qué transferencias hay pendientes?», «compras abiertas», «lista de empleados».
- **Acciones**, siempre con botón Confirmar (también puedes decir «sí» o «no»):
  - fijar precio o mínimo;
  - crear o desactivar empleados;
  - agregar un medicamento;
  - pedir, aprobar o despachar transferencias;
  - registrar clientes, si el cliente aceptó el aviso de privacidad;
  - registrar suplidores;
  - cambiar el nombre de la farmacia o el pie del comprobante;
  - deshacer.
- **Navegar:** «llévame a reportes», «abre el catálogo con amoxicilina».
- **Respuestas en voz alta:** botón de la bocina.

## Seguridad

- La IA **no escribe en la base de datos**. Solo consulta y **propone**. El cambio ocurre cuando tú confirmas, y el servidor vuelve a validar tus permisos.
- Las consultas se limitan a las sucursales que tu usuario puede ver. La cédula de los clientes se envía enmascarada.
- No envía contraseñas, claves ni el archivo `.env.local`. Los audios se transcriben y no se guardan.
- Hay un límite de 30 mensajes y 15 audios por minuto por usuario, que protege la cuota gratuita.
- No da diagnósticos ni dosis: deriva al farmacéutico.
- Si la IA en la nube falla o se acaba la cuota, el asistente sigue funcionando con las reglas.

## Al publicar en la web

En el servicio donde publiques el sistema (Vercel, Railway, Render…), agrega `AI_API_KEY` en la sección de variables de entorno. Para grabar con el micrófono, el sitio debe abrirse con `https://`. Estos servicios lo hacen solos.

## Pruebas

`scripts/qa/owner-agent-check.ts` prueba las 24 herramientas con una IA simulada, sin gastar cuota ni necesitar clave. Lee las instrucciones al inicio del archivo.
