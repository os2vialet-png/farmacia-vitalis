# Roles y permisos

## Principios

- **El backend decide.** Cada API y cada página vuelve a validar el permiso; ocultar un botón es solo comodidad.
- **Por sucursal.** Un rol se asigna a una sucursal concreta o es global (propietario). Pedir datos de otra sucursal responde 403.
- **Contraseña temporal = sin permisos.** Mientras `must_change_password` esté activo, la sesión solo puede cambiar la contraseña o cerrar sesión. Lo aplica `hasPermission` en `src/lib/auth/permissions.ts` para todo el sistema.
- **Gestión de empleados:** aunque el administrador tiene `users.*`, la API de empleados solo permite operar al propietario.

## Matriz (estado actual de la base)

| Permiso | Propietario | Administrador | Farmacéutico | Encargado de inventario | Vendedor |
|---|:-:|:-:|:-:|:-:|:-:|
| `assistant.use` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `audit.view` | ✓ | ✓ |  |  |  |
| `branches.manage` | ✓ |  |  |  |  |
| `branches.view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `catalog.create` | ✓ | ✓ |  | ✓ |  |
| `catalog.prices` | ✓ | ✓ |  |  |  |
| `catalog.update` | ✓ | ✓ |  | ✓ |  |
| `catalog.verify` | ✓ | ✓ | ✓ |  |  |
| `catalog.view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `customers.manage` | ✓ | ✓ | ✓ |  | ✓ |
| `customers.view` | ✓ | ✓ | ✓ |  | ✓ |
| `inventory.adjust` | ✓ | ✓ |  | ✓ |  |
| `inventory.manage` | ✓ | ✓ |  | ✓ |  |
| `inventory.view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `purchases.approve` | ✓ | ✓ |  |  |  |
| `purchases.create` | ✓ | ✓ |  | ✓ |  |
| `purchases.view` | ✓ | ✓ | ✓ | ✓ |  |
| `reports.view` | ✓ | ✓ | ✓ | ✓ |  |
| `sales.cancel` | ✓ | ✓ |  |  |  |
| `sales.create` | ✓ | ✓ | ✓ |  | ✓ |
| `sales.discount` | ✓ | ✓ |  |  |  |
| `sales.view` | ✓ | ✓ | ✓ |  | ✓ |
| `settings.manage` | ✓ |  |  |  |  |
| `transfers.approve` | ✓ | ✓ |  |  |  |
| `transfers.dispatch` | ✓ | ✓ |  | ✓ |  |
| `transfers.reconcile` | ✓ | ✓ |  | ✓ |  |
| `transfers.receive` | ✓ | ✓ |  | ✓ |  |
| `transfers.request` | ✓ | ✓ |  | ✓ |  |
| `transfers.view` | ✓ | ✓ | ✓ | ✓ |  |
| `users.assign_roles` | ✓ | ✓ |  |  |  |
| `users.manage` | ✓ | ✓ |  |  |  |
| `users.view` | ✓ | ✓ |  |  |  |

Los permisos `sales.discount`, `transfers.*`, `catalog.verify` y `catalog.prices` se agregaron en la migración `0001`. `transfers.reconcile` se agregó en la migración `0006`.

## Transferencias: qué sucursal decide cada paso

| Paso | Permiso | Sucursal |
|---|---|---|
| Solicitar | `transfers.request` | Destino (quien necesita la mercancía) |
| Aprobar o rechazar | `transfers.approve` | Origen |
| Despachar | `transfers.dispatch` | Origen |
| Recibir | `transfers.receive` | Destino |
| Conciliar diferencias: llegada tardía o dar por perdidas | `transfers.reconcile` | Destino |
| Conciliar diferencias: registrar devolución al origen | `transfers.reconcile` | Origen |
| Cancelar (antes del despacho) | `transfers.request` en destino o `transfers.approve` en origen | — |

La conciliación exige un motivo de al menos 10 caracteres en cada resolución; la devolución la registra el origen (la mercancía vuelve a su estante) y la llegada tardía o la pérdida las declara el destino. El backend vuelve a validar la sucursal en cada caso.

## Cambiar la matriz

Las asignaciones viven en `farmacia.role_permissions`. Cualquier cambio debe hacerse con una migración nueva en `database/migrations/` para que quede versionado.
