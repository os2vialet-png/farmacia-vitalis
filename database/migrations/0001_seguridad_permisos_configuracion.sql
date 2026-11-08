-- 0001: seguridad, permisos por rol y configuración del sistema.
-- Aditiva: no modifica ni elimina datos existentes.

-- Nuevos permisos.
INSERT INTO farmacia.permissions (code, name, description)
SELECT v.code, v.name, v.description
FROM (VALUES
  ('sales.discount',      'Aplicar descuentos',              'Puede aplicar descuentos en ventas del punto de venta'),
  ('transfers.view',      'Ver transferencias',              'Puede consultar transferencias entre sucursales'),
  ('transfers.request',   'Solicitar transferencias',        'Puede crear solicitudes de transferencia'),
  ('transfers.approve',   'Aprobar transferencias',          'Puede aprobar o rechazar solicitudes de su sucursal de origen'),
  ('transfers.dispatch',  'Despachar transferencias',        'Puede preparar y despachar mercancía desde la sucursal de origen'),
  ('transfers.receive',   'Recibir transferencias',          'Puede confirmar recepción en la sucursal de destino'),
  ('catalog.verify',      'Verificar productos',             'Puede marcar productos como verificados con evidencia'),
  ('catalog.prices',      'Gestionar precios por sucursal',  'Puede definir precios de venta por sucursal')
) AS v(code, name, description)
WHERE NOT EXISTS (SELECT 1 FROM farmacia.permissions p WHERE p.code = v.code);

-- Asignación de permisos nuevos según la matriz documentada en docs/PERMISOS.md.
INSERT INTO farmacia.role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
  ('owner', 'sales.discount'), ('owner', 'transfers.view'), ('owner', 'transfers.request'),
  ('owner', 'transfers.approve'), ('owner', 'transfers.dispatch'), ('owner', 'transfers.receive'),
  ('owner', 'catalog.verify'), ('owner', 'catalog.prices'),

  ('admin', 'sales.discount'), ('admin', 'transfers.view'), ('admin', 'transfers.request'),
  ('admin', 'transfers.approve'), ('admin', 'transfers.dispatch'), ('admin', 'transfers.receive'),
  ('admin', 'catalog.verify'), ('admin', 'catalog.prices'),

  ('pharmacist', 'transfers.view'), ('pharmacist', 'catalog.verify'),

  ('inventory_manager', 'transfers.view'), ('inventory_manager', 'transfers.request'),
  ('inventory_manager', 'transfers.dispatch'), ('inventory_manager', 'transfers.receive')
) AS m(role_code, permission_code)
JOIN farmacia.roles r ON r.code = m.role_code
JOIN farmacia.permissions p ON p.code = m.permission_code
WHERE NOT EXISTS (
  SELECT 1 FROM farmacia.role_permissions rp
  WHERE rp.role_id = r.id AND rp.permission_id = p.id
);

-- Configuración editable del sistema (clave/valor).
CREATE TABLE IF NOT EXISTS farmacia.app_settings (
  key varchar(80) PRIMARY KEY,
  value text NOT NULL,
  description text,
  updated_by uuid REFERENCES farmacia.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO farmacia.app_settings (key, value, description) VALUES
  ('currency', 'DOP', 'Moneda de los precios y comprobantes.'),
  ('pharmacy_name', 'Farmacia Vitalis', 'Nombre que aparece en comprobantes.'),
  ('clinical_referral_text', 'Para consultas clínicas, por favor habla con un farmacéutico en la sucursal.', 'Texto con el que el asistente deriva consultas clínicas.'),
  ('receipt_footer', 'Comprobante no fiscal. Gracias por su compra.', 'Pie de página de los comprobantes.')
ON CONFLICT (key) DO NOTHING;

-- Límite de intentos de login: se registra por usuario e IP en audit_logs (acción login_failed).
CREATE INDEX IF NOT EXISTS idx_audit_logs_login_failed
  ON farmacia.audit_logs (created_at)
  WHERE action = 'login_failed';

-- Historial de contraseñas no se guarda; el cambio fuerza nueva sesión.
