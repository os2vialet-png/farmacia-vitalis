# Farmacia Vitalis

Sistema interno de gestión farmacéutica multisucursal para una farmacia dominicana.
Next.js 16 (App Router) · React 19 · TypeScript · PostgreSQL 18 (esquema `farmacia`).

## Módulos

| Módulo | Ruta | Qué hace |
|---|---|---|
| Inicio | `/dashboard` | Sucursales y módulos disponibles según el rol |
| Punto de venta | `/pos` | Venta con validación de existencias, impuestos, descuentos autorizados, pagos y comprobante |
| Historial de ventas | `/ventas` | Consulta, comprobante imprimible y anulación autorizada |
| Clientes | `/clientes` | Ficha, historial de compras y consentimientos separados |
| Compras | `/purchases` | Órdenes, aprobación y recepción con lotes y vencimientos |
| Suplidores | `/suppliers` | Registro y edición de suplidores |
| Inventario | `/inventory` | Existencias, lotes, ajustes, alertas y movimientos por sucursal |
| Transferencias | `/transferencias` | Solicitud, aprobación, despacho, recepción y diferencias entre sucursales |
| Catálogo | `/catalogo` | Datos comerciales, verificación auditable y precios por sucursal |
| Reportes | `/reportes` | Ventas, rentabilidad, compras, existencias, vencimientos, movimientos y desempeño |
| Empleados | `/users` | Alta de empleados y asignación de rol por sucursal (solo propietario) |
| Auditoría | `/auditoria` | Registro de operaciones sensibles |
| Configuración | `/configuracion` | Textos de comprobantes y del asistente |
| Asistente público | `/asistente` | Disponibilidad y precio sin revelar cantidades; deriva consultas clínicas |

## Inicio rápido

```bash
npm install
npm run db:migrate
npm run build
npm run start
```

La guía completa está en [docs/INSTALACION.md](docs/INSTALACION.md).

## Documentación

- [Instalación y configuración](docs/INSTALACION.md)
- [Base de datos y migraciones](docs/BASE_DE_DATOS.md)
- [Roles y permisos](docs/PERMISOS.md)
- [Uso por módulo](docs/USO.md)
- [Mantenimiento y operación](docs/MANTENIMIENTO.md)
- [Pruebas](docs/PRUEBAS.md)
- [Presentación: qué es, objetivo, misión, visión, uso, web y otros dispositivos](docs/PRESENTACION.md)
- [Estado del proyecto: completado, pendiente y pruebas realizadas](docs/ESTADO.md)

## Comandos

| Comando | Uso |
|---|---|
| `npm run dev` | Servidor de desarrollo |
| `npm run build` / `npm run start` | Compilación y servidor de producción |
| `npm run typecheck` | Verificación de tipos |
| `npm run db:migrate` / `npm run db:migrate:dry` | Aplicar o simular migraciones |
| `npm run owner:reset-password -- <usuario>` | Restablecer contraseña desde la consola del servidor |
| `npm run catalog:quality` | Plan de calidad del catálogo (simulación; `-- --apply` para aplicar) |
| `npm run test:unit` | Pruebas unitarias |
| `npm run qa:setup` · `npm run test:api` · `npm run test:pages` · `npm run qa:teardown` | Pruebas de integración |
