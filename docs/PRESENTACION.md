# Farmacia Vitalis — Presentación del proyecto

## ¿Qué es?

Farmacia Vitalis es un **sistema web interno de gestión farmacéutica** para una farmacia dominicana con una o varias sucursales. Reúne en un solo lugar la venta en caja (punto de venta), el inventario por lote y vencimiento, las compras a suplidores, las transferencias entre sucursales, los clientes, el catálogo de medicamentos, los reportes y un asistente para clientes. Todo se guarda en una base de datos **PostgreSQL**.

## Objetivo

Que la farmacia venda, compre y controle su inventario con datos reales y trazables: saber qué hay en cada sucursal, de qué lote salió cada unidad, cuándo vence, quién hizo cada operación y cuánto se ganó, sin depender de hojas de cálculo ni de memoria.

## Misión

Dar a la farmacia una herramienta segura y sencilla que convierta cada venta, compra y movimiento de inventario en información confiable, protegiendo los datos de los clientes y cumpliendo las reglas sanitarias: solo se venden productos verificados, nunca se vende lo que no hay y nunca se vende un lote vencido.

## Visión

Ser la plataforma con la que Farmacia Vitalis crezca de una a muchas sucursales manteniendo el control: inventario consolidado, decisiones basadas en reportes reales, atención al cliente por web y WhatsApp sin revelar información interna, y una operación auditable en cada paso.

## ¿Cómo se creó?

1. **Base existente.** El proyecto ya tenía inicio de sesión, usuarios y roles, sucursales, inventario, catálogo, suplidores y compras, construidos con Next.js, React, TypeScript y PostgreSQL.
2. **Rescate y estabilización.** Se corrigieron errores de compilación, textos dañados, fugas de errores internos y fallas de seguridad del inicio de sesión.
3. **Catálogo oficial.** Se importó el registro sanitario de DIGEMAPS (MISPAS 2018-2026). Se activaron los productos con registro vigente, se marcaron 87 duplicados y se completaron presentaciones desde la fuente oficial, sin inventar datos.
4. **Módulos nuevos.** Contraseñas temporales obligatorias, punto de venta, clientes con consentimientos, reportes, transferencias, asistentes, imágenes de productos y gestión de empleados.
5. **Base de datos versionada.** Cada cambio de la base es una migración numerada (`database/migrations/0001` a `0008`) que se aplica una sola vez.
6. **Pruebas.** 10 pruebas unitarias, 122 de integración contra la API real y 44 de páginas por rol, más recorridos en navegador. Las pruebas detectaron defectos reales (venta duplicable por concurrencia, mensajes falsos de error, recepción con cantidad incorrecta) que se corrigieron.

## Cómo se usa (resumen)

| Quién | Qué hace | Dónde |
|---|---|---|
| Propietario | Crea empleados y les asigna rol y sucursal | Empleados |
| Farmacéutico | Verifica productos con evidencia del registro sanitario | Catálogo → Editar → Verificación |
| Encargado de inventario | Completa unidad de venta, presentación, marca, impuesto y foto | Catálogo → Editar |
| Administrador o propietario | Fija el precio por sucursal | Catálogo → Editar → Precio |
| Encargado de inventario | Compra a suplidores y recibe mercancía con lote y vencimiento | Compras |
| Vendedor o farmacéutico | Vende: busca, agrega, cobra y entrega comprobante | Punto de venta |
| Administrador | Anula ventas con motivo | Historial de ventas |
| Encargados | Solicitan, despachan y reciben mercancía entre sucursales | Transferencias |
| Propietario y gerentes | Consultan ventas, rentabilidad, vencimientos y desempeño | Reportes |
| Clientes | Preguntan si hay un producto y su precio | `/asistente` (público) |

### Asistente del dueño (`/asistente-dueno`, propietario y administradores)

Escribe órdenes en español. El asistente muestra qué va a hacer y **solo actúa cuando pulsas Confirmar**. Al ejecutar vuelve a validar los permisos, y todo queda en auditoría.

| Escribe | Qué hace |
|---|---|
| `avisos` | Resumen: ventas de hoy, stock bajo, lotes por vencer o vencidos, transferencias pendientes, productos sin verificar o sin precio, empleados con contraseña temporal |
| `crea un vendedor llamado Ana Gómez en Villa Mella` | Crea el empleado con contraseña temporal (roles: vendedor, farmacéutico, encargado de inventario, administrador; opcional `usuario agomez`) |
| `desactiva al usuario agomez` | Desactiva al empleado y cierra sus sesiones |
| `agrega el medicamento Amoxil forma cápsula concentración 500 mg presentación caja x 21 unidad caja marca GSK` | Crea el producto pendiente de verificación |
| `pon el precio de amoxil a 150 en Villa Mella` | Fija el precio en esa sucursal |
| `cambia el pie del comprobante a Gracias por preferirnos` | Cambia la configuración (también nombre de la farmacia y derivación clínica) |

| `stock bajo` · `por vencer` · `ventas de la semana` · `cuánto hay de amoxil` | Consultas directas al inventario y a las ventas en PostgreSQL |
| `pon el mínimo de amoxil a 20 en Villa Mella` | Fija el mínimo y el punto de reposición; desde ahí aparece en «avisos» y «stock bajo» |
| `deshacer` | Revierte tu última acción del asistente: reactiva o desactiva empleados, restaura el precio, el mínimo o la configuración anterior, o desactiva el producto creado |

Al abrir la pantalla, el asistente muestra los avisos del negocio sin que haya que pedirlos.

#### IA gratuita (opcional, en tu propia computadora)

Sin instalar nada, el asistente entiende las órdenes de la tabla. Para que entienda frases libres ("¿qué tengo que pedir esta semana?"), instala **Ollama**. Es gratis, corre en tu PC y los datos de la farmacia no salen de ella.

```bash
winget install Ollama.Ollama
```

```bash
ollama pull qwen2.5:7b
```

Agrega a `.env.local` la línea `OLLAMA_MODEL=qwen2.5:7b` y reinicia la aplicación. La pantalla mostrará «IA local activa».

La IA solo traduce tu frase a una de las órdenes de la tabla. Nunca toca la base de datos: la orden pasa por las mismas validaciones, permisos y confirmación. Si Ollama está apagado, el asistente sigue funcionando con las órdenes.

### Íconos y fotos de productos

Cada producto muestra su foto si se cargó una (por URL o subida desde Catálogo → Editar). Si no tiene foto, muestra un ícono según su forma farmacéutica (tableta, cápsula, jarabe, inyectable, crema, gotas, supositorio, inhalador o polvo) y su vía de uso (oral, inyectable, tópica, rectal o inhalada). No se descargan fotos de internet automáticamente: en medicamentos, una foto equivocada es peligrosa y la mayoría tiene derechos de autor.

### Sucursal de demostración

`Farmacia Vitalis - Santiago (demo)` (código `VITALIS-002`) tiene dirección y teléfono ficticios. Se crea con `npx tsx scripts/demo/create-demo-branch.ts`. Para retirarla, desactívala.

**Orden para empezar a vender:** crear empleados → completar y verificar productos → fijar precios → registrar una compra y recibirla → vender en el POS. El detalle de cada pantalla está en [USO.md](USO.md).

## Conexión con PostgreSQL

La aplicación se conecta con la variable `DATABASE_URL` de `.env.local` (base `farmacia_vitalis`, esquema `farmacia`). Para comprobar la conexión y las migraciones:

```bash
npm run db:migrate:dry
```

Si responde `No hay migraciones pendientes.`, la conexión funciona y la base está al día.

## Publicarlo en la web

Necesitas dos cosas: un servidor para la aplicación y una base PostgreSQL accesible por Internet.

**Opción A: servicios administrados (la más simple)**
1. Base de datos: crea una base PostgreSQL en un proveedor (por ejemplo Neon, Supabase o Railway). Copia su cadena de conexión.
2. Restaura tu base actual en ella:
   ```bash
   pg_dump "postgres://…local…/farmacia_vitalis" -Fc -n farmacia -f farmacia.dump
   ```
   ```bash
   pg_restore -d "postgres://…nube…" farmacia.dump
   ```
3. Aplicación: importa el repositorio de GitHub en Vercel (o Railway o Render). Define `DATABASE_URL` en sus variables de entorno y despliega.
4. Abre la URL que te den y entra con el propietario.

Revisa los planes y costos de cada proveedor antes de crear cuentas. Las capas gratuitas tienen límites.

**Opción B: tu propio servidor (VPS o PC dedicada)**

Instala Node.js 26 y PostgreSQL, clona el repositorio, crea `.env.local`, y luego ejecuta `npm install`, `npm run db:migrate`, `npm run build` y `npm run start`. Pon delante un proxy con HTTPS (Nginx o Caddy).

**Importante:** las fotos subidas se guardan en `public/uploads`. En servicios sin disco persistente (como Vercel) se perderían al redeployar. Para producción conviene un servidor con disco (opción B) o usar fotos por URL.

## Usarlo en otro dispositivo

- **Misma red (otra PC, tablet o celular en la farmacia):** en la PC principal ejecuta `npm run start -- -H 0.0.0.0 -p 3000` y abre desde el otro equipo `http://IP-DE-LA-PC:3000`. La IP se ve con `ipconfig`. Permite el puerto 3000 en el firewall de Windows.
- **Instalar el proyecto en otra computadora:** clona el repositorio desde GitHub, crea `.env.local` con tu `DATABASE_URL`, y ejecuta `npm install`, `npm run build` y `npm run start`. Para llevar también los datos, usa `pg_dump` y `pg_restore` como en la sección anterior.
- **Desde cualquier lugar:** publícalo en la web como se describe arriba.
