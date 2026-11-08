# Mantenimiento y operación

## Respaldos

Respaldo completo del esquema (formato personalizado):

```bash
pg_dump "postgres://…/farmacia_vitalis" -Fc -n farmacia -f backups/farmacia-AAAAMMDD.dump
```

Restauración en una base vacía:

```bash
pg_restore -d "postgres://…/farmacia_restaurada" backups/farmacia-AAAAMMDD.dump
```

La carpeta `backups/` está excluida del control de versiones porque contiene datos reales. Guarda copias fuera del servidor.

## Recuperar la contraseña del propietario

Solo quien tiene acceso al servidor y a la base puede hacerlo:

```bash
npx tsx --env-file=.env.local scripts/reset-owner-password.ts ADMIN
```

El script muestra los roles del usuario, pide escribir `RESTABLECER`, genera una contraseña temporal que se muestra **una sola vez**, obliga a cambiarla en el siguiente inicio de sesión, revoca todas sus sesiones y registra `password.reset_cli` en auditoría. Entrega la contraseña en persona o por un canal seguro.

## Límite de intentos de login

Ventana de 15 minutos, solo cuentan los fallos:

| Regla | Límite |
|---|---|
| Mismo usuario y misma IP | 5 |
| Mismo usuario sin IP identificable | 10 |
| Mismo usuario desde cualquier IP | 30 |
| Misma IP contra cualquier usuario | 50 |

El bloqueo siempre es temporal. Para que la regla por IP funcione detrás de un proxy, el proxy debe enviar `X-Forwarded-For`. Los usuarios inexistentes también cuentan, para no revelar qué cuentas existen, y el tiempo de respuesta es igual exista o no el usuario.

## Calidad del catálogo

```bash
npm run catalog:quality
```

Simula y muestra el plan. Para aplicarlo: `npm run catalog:quality -- --apply`. Guarda un respaldo JSON en `backups/` y audita cada cambio. Ya se aplicó una vez:

- 87 duplicados exactos marcados con `duplicate_of_product_id` y desactivados. Se conservó el registro con más referencias y, en empate, el más antiguo.
- 786 presentaciones completadas desde la descripción de empaque del registro oficial vigente.

No completa marcas, concentraciones ni unidades de venta, porque el registro no las trae de forma confiable.

## Activar WhatsApp

Requiere una cuenta de WhatsApp Business en Meta. **Meta cobra por conversación**: actívalo solo con la aprobación del propietario.

1. Crea la app en Meta y obtén el secreto y el token.
2. Define en `.env.local`: `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`.
3. Registra el webhook `https://<dominio>/api/assistant/whatsapp` con el mismo token de verificación.
4. Reinicia el servidor.

Sin `WHATSAPP_ACCESS_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`, el webhook valida firmas y procesa mensajes, pero no envía respuestas ni hace llamadas externas.

## Monitoreo

- **Auditoría** (`/auditoria`): accesos, cambios de contraseña, ventas, anulaciones, transferencias, cambios de catálogo y precios.
- **Reporte de próximos a vencer:** revísalo semanalmente.
- **Logs del servidor:** los errores internos se registran con su detalle, y al usuario solo se le muestra un mensaje genérico.

## Datos de prueba (QA)

Las pruebas crean cuentas `qa_*`, productos `QA PRUEBA…` y la sucursal `QA-002`. Las ventas de prueba se registran en la sucursal real configurada, por lo que **aparecen en sus reportes** hasta que se purguen. Hay un verificador de integridad: `npx tsx --env-file=.env.local scripts/qa/verify-purge.ts` (confirma que no quedan restos de QA y que la integridad referencial se mantiene).

Al terminar la entrega del 8 de noviembre de 2026 la purga se ejecutó (con respaldo previo en `backups/farmacia-20261108-014443.dump`); las suites pueden recrear todos los datos con `npm run qa:setup`.

```bash
npm run qa:teardown
```

Desactiva cuentas, productos, clientes de prueba y la sucursal QA. Para borrar las ventas, compras y transferencias de prueba (no se puede deshacer):

```bash
npx tsx scripts/qa/teardown.ts --purge
```

```bash
npx tsx scripts/qa/teardown.ts --purge --confirm
```

El primero solo muestra los conteos. La purga aborta si alguna operación mezcla productos QA con productos reales.
