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
