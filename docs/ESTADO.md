# Estado del proyecto

Última actualización: 8 de noviembre de 2026.

## Completado

### Fase 1. Seguridad y autenticación
- `must_change_password` aplicado en todo el backend (`hasPermission` niega todo) y en las páginas (redirección a `/cambiar-contrasena`).
- Cambio de contraseña: política (12+ caracteres, letra y número, sin usuario ni palabras comunes), revoca todas las sesiones y crea una nueva, con límite de intentos.
- Restablecimiento del propietario por consola: `scripts/reset-owner-password.ts`.
- Login: tiempo constante aunque el usuario no exista y límites por usuario e IP, siempre temporales (ver MANTENIMIENTO).
- Gestión de empleados: desactivar, reactivar, restablecer contraseña y cambiar rol o sucursal, con revocación inmediata de sesiones.
- Matriz de permisos revisada y versionada (migración 0001); aislamiento por sucursal en todas las APIs (`src/lib/access.ts`).
- Corregido: el panel redirigía en bucle a cualquier rol distinto de propietario; la raíz `/` mostraba la plantilla de Next.js.
- Auditoría con IP en login, logout, contraseñas, ventas, anulaciones, transferencias, clientes, catálogo, precios, configuración y empleados.

### Fase 2. Punto de venta
- Búsqueda solo de productos vendibles, carrito, descuentos con permiso y motivo, varios métodos de pago, cambio solo en efectivo.
- Confirmación transaccional con FIFO por vencimiento, bloqueos `FOR UPDATE`, idempotencia y trazabilidad por lote.
- Comprobante imprimible (no fiscal), historial por sucursal y fechas, anulación autorizada que repone los mismos lotes.

### Fase 3. Clientes
- Registro y edición mínimos, documento opcional y enmascarado, consentimientos comerciales independientes con historial inmutable, compras visibles solo en sucursales autorizadas y auditoría sin datos personales.

### Fase 4. Reportes
- Nueve reportes desde PostgreSQL con alcance por sucursal y fechas en hora dominicana (página y API).
- Exportación a CSV de cada reporte (`format=csv`): con BOM UTF-8 para Excel y escapado según RFC 4180.

### Fase 5. Transferencias
- Solicitud, aprobación (total o parcial), rechazo, despacho FIFO, recepción con diferencias y motivo obligatorio, cancelación antes del despacho y trazabilidad por lote y usuario.
- Conciliación de diferencias después de la recepción (permiso `transfers.reconcile`): llegada tardía en destino, devolución al origen o dar por perdidas, cada una con motivo obligatorio, dentro de una transacción con bloqueos y registro de auditoría. Los intentos repetidos responden 409.

### Fase 6. Asistentes
- Motor común: catálogo verificado, disponibilidad sí o no por sucursal, precio, presentación y unidad de venta; nunca cantidades; derivación clínica; emergencias al 911; límite por IP o remitente persistido en la base (`assistant_rate_limits`, falla cerrado si la base falla); sin guardar conversaciones.
- Asistente web público (`/asistente`) y webhook de WhatsApp con validación de firma, listo pero sin enviar mensajes hasta configurar credenciales.

### Fase 7. Catálogo
- 26.420 productos con registro oficial vigente activados para compras (aprobado por el propietario), sin verificar en bloque.
- 87 duplicados exactos desactivados con referencia al registro conservado; 786 presentaciones completadas desde el registro oficial.
- Verificación individual auditable con validación de evidencia en el servidor; precios por sucursal con historial; impuesto por producto.

### Fase 8. Pruebas, purga de datos y documentación
- Ver [PRUEBAS.md](PRUEBAS.md): unitarias 12/12, API 143/143, páginas 44/44, recorridos en navegador real.
- Documentación en `docs/`.
- Purga de los datos de prueba ejecutada y verificada: `scripts/qa/teardown.ts --purge --confirm` borró las ventas, compras, transferencias, movimientos y precios QA, y desactivó las cuentas, los productos y la sucursal QA. `scripts/qa/verify-purge.ts` confirma que no quedan restos y que la integridad referencial se mantiene. Antes de la purga se creó `backups/farmacia-20261108-014443.dump`. Las cuentas y productos QA se pueden recrear con `scripts/qa/setup.ts` y `scripts/qa/teardown.ts` sin `--purge`.

## Pendiente

### Decisiones del propietario
1. **Verificar productos para vender.** Hoy hay 0 productos reales verificados, así que el POS no puede vender nada. Para cada producto que se venda, el farmacéutico debe verificarlo, y el personal debe asignarle unidad de venta y precio en cada sucursal. No se hizo en bloque, según tus reglas.
2. **Tratamiento fiscal de los medicamentos.** No se asumió ninguna tasa. Cada producto tiene `tax_rate` vacío, lo que equivale a exento. El contador debe indicar qué productos llevan ITBIS.
3. **Contraseña del propietario `ADMIN`.** No se conoce. Para entrar, ejecuta el restablecimiento por consola (`scripts/reset-owner-password.ts`).

### Requieren un servicio externo
4. **WhatsApp:** requiere una cuenta de Meta con costo por conversación. La integración está lista; falta configurar credenciales.
5. **Comprobante fiscal (NCF):** requiere autorización e integración con la DGII. El comprobante actual es no fiscal.

### Limitaciones conocidas
6. El POS no usa `quantity_reserved` (reservas). La columna se respeta en los cálculos, pero ningún flujo la incrementa.
7. Las pantallas de inventario y compras existentes se conservaron; se auditaron sus APIs y se corrigió su integración (navegación y permisos), pero no se rediseñaron.
8. La exportación de reportes es a CSV (compatible con Excel); no hay XLSX nativo.

## Respaldos generados durante el trabajo
- `backups/farmacia-20261108-002640.dump`: respaldo completo del esquema antes de las migraciones.
- `backups/farmacia-20261108-014443.dump`: respaldo del esquema justo antes de purgar los datos de prueba (193 ventas, 51 compras, 53 transferencias, 316 movimientos, 34 precios).
- `backups/catalogo-antes-calidad-*.json`: estado previo de los productos modificados por la calidad del catálogo.
- `backups/*.bak`: versiones previas de los archivos de compras corregidos.
