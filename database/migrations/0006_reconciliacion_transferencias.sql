-- 0006: permiso y datos para reconciliar diferencias de transferencias recibidas.
-- Aditiva.

-- Nuevo permiso: cerrar lo que no llegó tras la recepción de una transferencia.
INSERT INTO farmacia.permissions (code, name, description)
SELECT v.code, v.name, v.description
FROM (VALUES
  ('transfers.reconcile', 'Reconciliar diferencias de transferencias',
   'Puede cerrar las diferencias de una transferencia recibida: registrar llegada tardía, devolución a origen o dar por perdidas')
) AS v(code, name, description)
WHERE NOT EXISTS (SELECT 1 FROM farmacia.permissions p WHERE p.code = v.code);

-- Asignación según la matriz documentada en docs/PERMISOS.md.
INSERT INTO farmacia.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('owner', 'transfers.reconcile'),
  ('admin', 'transfers.reconcile'),
  ('inventory_manager', 'transfers.reconcile')
) AS m(role_code, permission_code)
JOIN farmacia.roles r ON r.code = m.role_code
JOIN farmacia.permissions p ON p.code = m.permission_code
WHERE NOT EXISTS (SELECT 1 FROM farmacia.role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id);

-- Resolución de la diferencia por línea: qué decisión se tomó, quién, cuándo y con qué motivo.
-- returned: las unidades volvieron al estante de origen.
-- found_late: las unidades llegaron después y se reciben en destino.
-- written_off: las unidades se dan por perdidas; sin cambio de inventario.
ALTER TABLE farmacia.transfer_items
  ADD COLUMN IF NOT EXISTS missing_resolution varchar(20),
  ADD COLUMN IF NOT EXISTS missing_resolved_by uuid REFERENCES farmacia.users(id),
  ADD COLUMN IF NOT EXISTS missing_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS missing_resolution_reason text;

ALTER TABLE farmacia.transfer_items
  DROP CONSTRAINT IF EXISTS transfer_items_missing_resolution_check;

ALTER TABLE farmacia.transfer_items
  ADD CONSTRAINT transfer_items_missing_resolution_check
  CHECK (
    missing_resolution IS NULL OR (
      missing_resolution IN ('returned', 'found_late', 'written_off')
      AND missing_resolved_by IS NOT NULL
      AND missing_resolved_at IS NOT NULL
      AND missing_resolution_reason IS NOT NULL AND btrim(missing_resolution_reason) <> ''
    )
  ) NOT VALID;
