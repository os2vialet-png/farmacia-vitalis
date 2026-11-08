# Uso por módulo

## Antes de vender: preparar el catálogo

El catálogo importado de DIGEMAPS (26.333 productos activos) llega **sin verificar** y **sin unidad de venta**. Por regla, el POS solo vende productos que cumplen las cuatro condiciones:

1. Activo.
2. Verificado (`verification_status = 'verified'`).
3. Con unidad de venta.
4. Con precio vigente en la sucursal.

Para cada producto que la farmacia venderá, en **Catálogo → Editar**:

1. **Datos comerciales** (encargado de inventario, administrador o propietario): unidad de venta, presentación, concentración, marca e impuesto. Completa solo lo que respalden el registro sanitario o la factura del suplidor.
2. **Verificación** (farmacéutico, administrador o propietario): con evidencia de registro sanitario, el sistema comprueba que el número exista en el registro oficial, esté vigente, no vencido y con el mismo nombre. La revisión manual exige una justificación de al menos 20 caracteres. Cada verificación queda en un historial que no se puede borrar.
3. **Precio por sucursal** (administrador o propietario): incluye el impuesto.

Los productos sin verificar sí se pueden **comprar** y **transferir**, pero no vender.

## Punto de venta (`/pos`)

1. Elige la sucursal (solo aparecen las autorizadas).
2. Busca por nombre, marca, registro sanitario o código de barras. Solo aparecen productos vendibles con existencias.
3. Ajusta cantidades. Los descuentos requieren `sales.discount` y un motivo.
4. Cliente opcional (búsqueda por nombre o teléfono).
5. Registra uno o varios pagos. El cambio solo se entrega en efectivo.
6. **Confirmar venta.** Si la conexión falla, el botón puede pulsarse otra vez: la clave de la operación evita cobrar dos veces. Si la pantalla dice que se perdió la conexión, revisa el historial antes de volver a cobrar.

El comprobante es **no fiscal**. La emisión de NCF requiere autorización de la DGII y no está implementada.

## Historial y anulaciones (`/ventas`)

Filtra por sucursal, fechas (hora de República Dominicana) y estado. El comprobante se imprime con **Imprimir comprobante**.
**Anular venta** (`sales.cancel`) exige un motivo de al menos 10 caracteres. Las unidades vuelven a los mismos lotes de donde salieron. Una venta se anula una sola vez.

## Clientes (`/clientes`)

- Solo es obligatorio el nombre y la confirmación del aviso de tratamiento de datos. El documento es opcional y se muestra enmascarado.
- Cada consentimiento comercial (WhatsApp, correo, SMS) se responde por separado y puede quedar sin respuesta.
- En la ficha se registra cada cambio de consentimiento. El historial no se puede editar ni borrar.
- Las compras del cliente solo se ven en las sucursales a las que el usuario tiene acceso.

## Compras (`/purchases`)

Crear orden → **Aprobar** → **Recibir**: lote y vencimiento obligatorios, sin recibir más de lo pendiente y sin lotes vencidos. La recepción actualiza el inventario de la sucursal de la orden.

## Transferencias (`/transferencias`)

1. La sucursal que necesita mercancía la **solicita** a otra.
2. La sucursal origen **aprueba** (puede aprobar menos) o **rechaza** con motivo.
3. La sucursal origen **despacha**: sale del inventario por lote, primero el que vence antes.
4. La sucursal destino **recibe** e indica lo que llegó. Si falta algo, el motivo es obligatorio y la diferencia queda registrada.
5. **Conciliación** (`transfers.reconcile`): quien recibió la transferencia ve en su página el panel de **Registrar conciliación** y cierra cada diferencia con una de tres resoluciones, todas con motivo obligatorio (mínimo 10 caracteres):
   - **Llegada tardía**: las unidades aparecieron después y se reciben en destino; suman al inventario con el mismo lote.
   - **Devolución al origen**: la mercancía nunca salió de la sucursal de origen; la vuelve a registrar el origen y reingresa a su estante.
   - **Dadas por perdidas**: se cierra la diferencia sin mover inventarios, dejando constancia de quién la resolvió y por qué.

Cada reconciliación es transaccional y auditable; la misma línea no se concilia dos veces. Así se termina la etiqueta de "diferencia en tránsito" y los inventarios quedan justificados.

Se puede cancelar antes del despacho.

## Reportes (`/reportes`)

Ventas por período y por sucursal, productos más vendidos, rentabilidad (ingreso sin impuesto menos costo de lotes; las líneas sin costo se cuentan aparte), compras, existencias con valor a costo, próximos a vencer, movimientos y desempeño por sucursal. Solo incluyen las sucursales con `reports.view` del usuario.

Cada reporte se exporta con **Exportar CSV**, un enlace que pide la misma API con `format=csv` y los mismos filtros. El archivo lleva BOM UTF-8 para que Excel lo abra bien y caracteres escapados según RFC 4180.

## Asistente web (`/asistente`) y WhatsApp

Informan disponibilidad (sí o no, y en qué sucursales), presentación, unidad de venta y precio de productos **verificados**. Nunca revelan cantidades. Derivan cualquier consulta clínica (síntomas, dosis, recomendaciones) al farmacéutico. Ante palabras de emergencia indican llamar al 911. No guardan el contenido de las conversaciones.

## Empleados (`/users`, solo propietario)

- **Crear:** nombre, usuario, rol y sucursal. Se genera una contraseña temporal que se muestra una sola vez y el empleado debe cambiarla al entrar.
- **Desactivar:** el empleado no puede iniciar sesión y sus sesiones abiertas se cierran al instante. Úsalo cuando alguien deja la farmacia.
- **Restablecer contraseña:** genera una temporal nueva y cierra sus sesiones.
- **Cambiar rol o sucursal:** reemplaza la asignación y aplica desde la siguiente acción del empleado.
- Las cuentas de propietario no se administran desde aquí: se recuperan por consola (ver MANTENIMIENTO). Nadie puede aplicarse estas acciones a sí mismo.

## Cambio de contraseña

Cualquier usuario puede cambiarla desde **Cambiar contraseña** en el menú. Política: mínimo 12 caracteres, al menos una letra y un número, sin el nombre de usuario y sin palabras comunes. Al cambiarla se cierran las demás sesiones.
