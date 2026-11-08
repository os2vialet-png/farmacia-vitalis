# Instalación y configuración

## Requisitos

- Node.js 26 o superior.
- PostgreSQL 18 con una base de datos `farmacia_vitalis`.
- Windows (PowerShell) o cualquier sistema donde corra Node.js.

## 1. Variables de entorno

Crea `.env.local` en la raíz del proyecto. **Nunca lo compartas ni lo subas al control de versiones** (ya está en `.gitignore`).

| Variable | Obligatoria | Uso |
|---|---|---|
| `DATABASE_URL` | Sí | Cadena de conexión a PostgreSQL (`postgres://usuario:clave@host:5432/farmacia_vitalis`) |
| `WHATSAPP_VERIFY_TOKEN` | No | Token para registrar el webhook en Meta |
| `WHATSAPP_APP_SECRET` | No | Secreto de la app de Meta para validar firmas |
| `WHATSAPP_ACCESS_TOKEN` | No | Token para enviar respuestas por WhatsApp (tiene costo; ver MANTENIMIENTO) |
| `WHATSAPP_PHONE_NUMBER_ID` | No | Identificador del número de WhatsApp Business |

Sin las variables de WhatsApp, el asistente de WhatsApp queda desactivado y el asistente web funciona normal.

## 2. Dependencias

```bash
npm install
```

## 3. Base de datos

El esquema base (catálogo, inventario, compras, usuarios) se creó con los scripts de `database/*.sql`.
Los módulos nuevos se aplican con migraciones versionadas:

```bash
npm run db:migrate:dry
```

```bash
npm run db:migrate
```

Detalles en [BASE_DE_DATOS.md](BASE_DE_DATOS.md). Antes de migrar en producción, haz un respaldo (ver MANTENIMIENTO).

## 4. Propietario inicial

Si la base no tiene propietario, crea uno desde una terminal interactiva:

```bash
npx tsx --env-file=.env.local scripts/create-owner.ts
```

Si ya existe pero se perdió la contraseña, usa el restablecimiento por consola (ver MANTENIMIENTO).

## 5. Compilar y ejecutar

```bash
npm run build
```

```bash
npm run start
```

Por defecto escucha en `http://localhost:3000`. Para otro puerto: `npm run start -- -p 3100`.

## 6. Primer uso

1. Entra con el propietario. Si su contraseña es temporal, el sistema pedirá cambiarla antes de mostrar cualquier módulo.
2. En **Empleados**, crea las cuentas del personal con su rol y sucursal. Cada cuenta nueva recibe una contraseña temporal que se muestra una vez.
3. En **Catálogo**, prepara los productos que se venderán (ver USO: el catálogo importado llega sin verificar y sin unidad de venta).
4. Registra suplidores y la primera compra en **Compras** para tener existencias.

## Despliegue

- Detrás de un proxy (Nginx, IIS), envía `X-Forwarded-For` con la IP real del cliente: el límite de intentos de login la usa.
- Usa HTTPS en producción. La cookie de sesión se marca `Secure` cuando `NODE_ENV=production`.
- El limitador del asistente web se cuenta en la base (`farmacia.assistant_rate_limits`): el límite se mantiene entre instancias. Si la base no responde, el asistente responde que no está disponible en lugar de quedarse sin límite.
