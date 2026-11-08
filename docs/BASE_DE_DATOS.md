# Base de datos

PostgreSQL 18, base `farmacia_vitalis`, esquema `farmacia`.

## Migraciones

| Archivo | Contenido |
|---|---|
| `database/catalog-schema.sql`, `inventory-module.sql`, `purchases-module.sql` | Esquema base previo (aplicado manualmente antes de las migraciones versionadas) |
| `database/migrations/0001_seguridad_permisos_configuracion.sql` | Permisos nuevos, matriz por rol, `app_settings`, índice para límite de login |
| `0002_clientes_consentimientos.sql` | `customers`, `customer_consents` (inmutable) |
| `0003_punto_de_venta.sql` | `tax_rate` y `duplicate_of_product_id` en productos, `catalog_verifications` (inmutable), `sales`, `sale_items`, `sale_item_lots`, `sale_payments` |
| `0004_transferencias.sql` | `transfers`, `transfer_items`, `transfer_item_lots` |
| `0005_transferencias_diferencias.sql` | Motivo obligatorio de diferencias en recepción |
| `0006_reconciliacion_transferencias.sql` | Permiso `transfers.reconcile` y columnas `missing_resolution`, `missing_resolved_by`, `missing_resolved_at`, `missing_resolution_reason` (con CHECK que exige motivo y resolutor cuando hay resolución: `returned`, `found_late`, `written_off`) |
| `0007_asistente_limites.sql` | Tabla `assistant_rate_limits`: el límite de solicitudes del asistente web se cuenta en la base y sobrevive a reinicios y varias instancias; falla cerrada si la base falla |

El ejecutor `scripts/migrate.ts` guarda cada versión con su checksum SHA-256 en `farmacia.schema_migrations`. Cada migración corre en su propia transacción. Si un archivo ya aplicado cambia, el ejecutor se detiene.

**Reglas:**
- Las migraciones son aditivas. No se borran tablas, columnas ni datos.
- Nunca se edita una migración aplicada: se crea una nueva con el siguiente número.
- Antes de migrar en producción: respaldo con `pg_dump` (ver MANTENIMIENTO).

## Garantías de integridad

| Garantía | Cómo se cumple |
|---|---|
| Sin inventario negativo | `CHECK (quantity_on_hand >= 0)`, `CHECK (quantity_remaining >= 0)`, `CHECK (quantity_reserved <= quantity_on_hand)` |
| Sin ventas duplicadas | `sales.idempotency_key UNIQUE`; el POS genera una clave por venta y la reutiliza en reintentos |
| Sin movimientos duplicados | `inventory_movements.idempotency_key` único (`sale:<venta>:<lote>`, `sale-cancel:…`, `transfer-out:…`, `transfer-in:…`, `transfer-return:…`, `transfer-late:…`) |
| Venta sin sobreventa concurrente | `SELECT … FOR UPDATE` sobre existencias y lotes dentro de la transacción |
| Una sola anulación | Bloqueo de la venta y verificación de estado dentro de la transacción |
| Transferencias sin doble despacho | Bloqueo de la transferencia y verificación de estado |
| Recepción no mayor que lo despachado | `CHECK (quantity_received + quantity_missing <= quantity_dispatched)` |
| Diferencias explicadas | `CHECK (quantity_missing = 0 OR discrepancy_reason IS NOT NULL)` |
| Conciliación coherente y única | `CHECK`: una resolución exige resolutor, fecha y motivo no vacío; la API la bloquea con `FOR UPDATE` y responde 409 en un segundo intento |
| Sin movimientos espurios al conciliar | `found_late` recibe lo pendiente con `transfer_in`; `returned` repone al origen con `adjustment_in`; `written_off` no mueve inventarios |
| Historiales inmutables | Triggers `forbid_mutation` en `customer_consents` y `catalog_verifications` |
| Tipos de movimiento coherentes | `CHECK` que exige signo positivo o negativo según el tipo |

## Reglas de negocio en la base

- **Lotes vendibles:** estado `available`, existencia mayor que 0 y vencimiento igual o posterior a hoy. Los lotes sin fecha de vencimiento no se venden.
- **Cantidad vendible:** la menor entre existencias libres (`on_hand - reserved`) y la suma de lotes vendibles.
- **Despacho FIFO:** ventas y transferencias salen primero del lote que vence antes.
- **Precios:** `product_branch_prices`. Al fijar un precio nuevo se cierra el anterior en el mismo instante; nunca hay dos vigentes.
- **Precio con impuesto incluido:** `base = total / (1 + tasa)`, `impuesto = total - base`. Si `tax_rate` es NULL, el producto se trata como exento.

## Zona horaria

Fechas en `timestamptz`. Reportes y comprobantes usan `America/Santo_Domingo`.

## Auditoría

`farmacia.audit_logs` registra usuario, sucursal, acción, entidad, valores anteriores y nuevos, e IP. Acciones registradas: `login`, `login_failed`, `logout`, `password.change`, `password.change_failed`, `password.reset_cli`, `sale.create`, `sale.cancel`, `transfer.request|approve|reject|dispatch|receive|cancel|reconcile`, `customer.create|update|deactivate|consent_granted|consent_revoked`, `catalog.update|verify|price_change|deduplicate|presentation_from_registry|bulk_activate`, `purchase.*`, `settings.update`, `assistant.web_query`, `assistant.whatsapp_query`, entre otras. Los registros de clientes no guardan datos personales, solo qué campos cambiaron.
