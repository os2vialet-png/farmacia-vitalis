# Pruebas

## Cómo ejecutarlas

```bash
npm run test:unit
```

Integración (necesita el servidor de producción en el puerto 3100):

```bash
npm run build
```

```bash
npm run qa:setup
```

En otra terminal, con valores de prueba para WhatsApp (no son credenciales reales):

```bash
WHATSAPP_APP_SECRET=qa-test-secret WHATSAPP_VERIFY_TOKEN=qa-verify-token npx next start -p 3100
```

En PowerShell: `$env:WHATSAPP_APP_SECRET="qa-test-secret"; $env:WHATSAPP_VERIFY_TOKEN="qa-verify-token"; npx.cmd next start -p 3100`.

```bash
npm run test:api
```

```bash
npm run qa:setup && npm run test:pages
```

Al terminar:

```bash
npm run qa:teardown
```

`test:api` deja a una cuenta QA con contraseña temporal (lo prueba a propósito); por eso `test:pages` se ejecuta después de un `qa:setup` nuevo.

## Qué cubren

| Suite | Pruebas | Alcance |
|---|---|---|
| `test:unit` | 12 | Centavos, impuesto incluido, descuentos, FIFO, cambio, cantidad vendible, política de contraseñas, escapado CSV |
| `test:api` | 143 | Autenticación, límites de intentos, contraseña temporal, cambio y restablecimiento de contraseña, permisos por rol, aislamiento entre sucursales, POS, idempotencia, concurrencia, anulaciones, clientes y consentimientos, transferencias con diferencias y despachos simultáneos, conciliación de transferencias (llegada tardía, devolución, dar por perdidas, permisos por sucursal e idempotencia), reportes contra la base y exportación CSV, asistentes web y WhatsApp, configuración, gestión de empleados, auditoría e invariantes de inventario |
| `test:pages` | 44 | Cada página por rol: carga con permiso, redirige sin permiso y no expone contenido protegido |

## Resultados de la entrega (8 de noviembre de 2026)

- `test:unit`: 12/12.
- `test:api`: 143/143.
- `test:pages`: 44/44.
- `tsc --noEmit` y `next build`: sin errores.
- Navegador real: inicio de sesión, venta completa en el POS con comprobante, alta de cliente con consentimientos y dos transferencias completas (solicitud, aprobación, despacho y recepción). Sin errores en la consola.
- Navegador real (2ª pasada): conciliación de una transferencia recibida desde el panel de la página (`written_off`): el chip "Dadas por perdidas" aparece en la columna Diferencia con el usuario que la resolvió, la fila de `transfer_items` queda con `missing_resolution` y motivo, y `farmacia.audit_logs` registra `transfer.reconcile`. Sin errores en la consola.

## Defectos encontrados por las pruebas y corregidos

| Defecto | Cómo se detectó | Corrección |
|---|---|---|
| Agotamiento del pool de conexiones: una venta confirmada respondía 500 con el mensaje "no se descontó inventario" | 10 ventas simultáneas | La conexión se libera tras el `COMMIT`; los fallos posteriores al `COMMIT` responden éxito |
| `password1234` pasaba la política | Prueba de política | Se valida la parte alfabética contra palabras comunes |
| El asistente trataba "hola" como búsqueda de producto | Prueba de saludo | Saludos como palabras vacías |
| El alta de cliente mostraba "sin conexión" aunque se había guardado (riesgo de duplicados) | Navegador real | Referencia al formulario capturada antes del `await` |
| La recepción de transferencias mostraba 0 en lugar de lo despachado | Navegador real | El componente se reinicia al cambiar el estado |
| Título de la aplicación "Create Next App" | Navegador real | Metadatos en español |
| La lista de empleados quedaba en "Consultando empleados…" | Navegador real | Se quitó un `<Suspense>` redundante que desmontaba el componente |
| Movimientos mostraban códigos técnicos (`purchase_receipt`, `expired`) | Navegador real | Etiquetas alineadas con los tipos de la base |
| Efectos con `setState` síncrono y respuestas viejas que sobrescribían a las nuevas | ESLint | Consulta pura + aplicación en el callback con cancelación |
| Fila de existencia en 0 de PROTAMINA, residuo de la primera prueba de compras | Navegador real | Eliminada con auditoría (sin lotes, movimientos ni compras) |
| El límite de solicitudes del asistente web era en memoria: con varias instancias del servidor, cada una contaba aparte | Revisión de requisitos de despliegue | Migración `0007`: tabla `assistant_rate_limits` con UPSERT atómico. Si la base falla, el asistente responde que no está disponible (falla cerrada, nunca sin límite) |
| La consulta del límite del asistente fallaba con «columna window_seconds ambigua» (Postgres 42702) | Prueba repetida del asistente tras migrar a base | Las referencias a la fila anterior se califican con el alias de la tabla |

## Datos de prueba

Ver [MANTENIMIENTO.md](MANTENIMIENTO.md#datos-de-prueba-qa). `qa:setup` limpia los registros `login_failed` QA de corridas anteriores, por lo que las suites se pueden repetir sin quedarse sin intentos de login. Tras `qa:teardown`, las cuentas y productos QA quedan desactivados y sesiones revocadas; si además se pasa `--purge --confirm`, se borran también ventas, compras, transferencias, movimientos y precios de QA. Al cerrar el entrega, la purga ya se ejecutó (ver [ESTADO.md](ESTADO.md)).

## Agente de IA del asistente del dueño

`npx tsx scripts/qa/owner-agent-check.ts` — 30 pruebas de las 24 herramientas con una IA simulada (sin clave ni cuota). El servidor 3100 debe iniciarse con `AI_API_KEY=simulada AI_BASE_URL=http://127.0.0.1:4599/v1`. Resultado del 08/11/2026: 30/30. En la misma fecha: API 143/143, asistente 26/26, páginas 44/44, unitarias 12/12.
