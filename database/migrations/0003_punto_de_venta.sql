-- 0003: punto de venta, impuestos por producto, verificación auditable y deduplicación.
-- Aditiva. No modifica filas existentes salvo columnas nuevas con valor NULL.

-- Impuesto por producto. NULL = no configurado (se trata como exento y la interfaz lo señala).
ALTER TABLE farmacia.catalog_products
  ADD COLUMN IF NOT EXISTS tax_rate numeric(5,4),
  ADD COLUMN IF NOT EXISTS duplicate_of_product_id uuid REFERENCES farmacia.catalog_products(id);

ALTER TABLE farmacia.catalog_products
  DROP CONSTRAINT IF EXISTS catalog_products_tax_rate_check;
ALTER TABLE farmacia.catalog_products
  ADD CONSTRAINT catalog_products_tax_rate_check
  CHECK (tax_rate IS NULL OR (tax_rate >= 0 AND tax_rate <= 1));

CREATE INDEX IF NOT EXISTS idx_catalog_products_duplicate_of
  ON farmacia.catalog_products (duplicate_of_product_id)
  WHERE duplicate_of_product_id IS NOT NULL;

-- Precios por sucursal: índice para la consulta de precio vigente.
CREATE INDEX IF NOT EXISTS idx_product_branch_prices_lookup
  ON farmacia.product_branch_prices (product_id, branch_id, effective_from DESC);

-- Verificación auditable (historial de solo inserción).
CREATE TABLE IF NOT EXISTS farmacia.catalog_verifications (
  id bigserial PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES farmacia.catalog_products(id),
  previous_status varchar(20) NOT NULL,
  new_status varchar(20) NOT NULL CHECK (new_status IN ('pending', 'verified', 'needs_review')),
  evidence_type varchar(40) NOT NULL,
  evidence_reference text NOT NULL CHECK (btrim(evidence_reference) <> ''),
  notes text,
  verified_by uuid REFERENCES farmacia.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_catalog_verifications_product
  ON farmacia.catalog_verifications (product_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_catalog_verifications_immutable ON farmacia.catalog_verifications;
CREATE TRIGGER trg_catalog_verifications_immutable
  BEFORE UPDATE OR DELETE ON farmacia.catalog_verifications
  FOR EACH ROW EXECUTE FUNCTION farmacia.forbid_mutation();

-- Secuencia de números de venta.
CREATE SEQUENCE IF NOT EXISTS farmacia.sale_number_seq START 1;

-- Ventas (cabecera).
CREATE TABLE IF NOT EXISTS farmacia.sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_number varchar(30) NOT NULL UNIQUE,
  branch_id uuid NOT NULL REFERENCES farmacia.branches(id),
  customer_id uuid REFERENCES farmacia.customers(id),
  status varchar(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'cancelled')),
  subtotal numeric(14,2) NOT NULL CHECK (subtotal >= 0),
  discount_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_total >= 0),
  tax_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_total >= 0),
  total numeric(14,2) NOT NULL CHECK (total >= 0),
  amount_paid numeric(14,2) NOT NULL CHECK (amount_paid >= 0),
  change_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (change_amount >= 0),
  currency varchar(3) NOT NULL DEFAULT 'DOP',
  idempotency_key varchar(80) NOT NULL UNIQUE,
  cashier_id uuid NOT NULL REFERENCES farmacia.users(id),
  notes text,
  cancel_reason text,
  cancelled_by uuid REFERENCES farmacia.users(id),
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    status <> 'cancelled'
    OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancel_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_sales_branch_date ON farmacia.sales (branch_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON farmacia.sales (customer_id) WHERE customer_id IS NOT NULL;

-- Líneas de venta. Guardan un snapshot del nombre, precio y costo al momento de vender.
CREATE TABLE IF NOT EXISTS farmacia.sale_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES farmacia.sales(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES farmacia.catalog_products(id),
  product_name varchar(300) NOT NULL,
  sale_unit varchar(60) NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  unit_cost numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  discount_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  discount_reason text,
  tax_rate numeric(5,4) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0 AND tax_rate <= 1),
  tax_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  line_total numeric(14,2) NOT NULL CHECK (line_total >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sale_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_sale_items_product ON farmacia.sale_items (product_id);

-- Trazabilidad: de qué lote salió cada unidad vendida.
CREATE TABLE IF NOT EXISTS farmacia.sale_item_lots (
  id bigserial PRIMARY KEY,
  sale_item_id uuid NOT NULL REFERENCES farmacia.sale_items(id) ON DELETE RESTRICT,
  lot_id uuid NOT NULL REFERENCES farmacia.inventory_lots(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_cost numeric(14,4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0)
);

CREATE INDEX IF NOT EXISTS idx_sale_item_lots_item ON farmacia.sale_item_lots (sale_item_id);
CREATE INDEX IF NOT EXISTS idx_sale_item_lots_lot ON farmacia.sale_item_lots (lot_id);

-- Pagos de la venta (una venta puede tener varios métodos).
CREATE TABLE IF NOT EXISTS farmacia.sale_payments (
  id bigserial PRIMARY KEY,
  sale_id uuid NOT NULL REFERENCES farmacia.sales(id) ON DELETE RESTRICT,
  method varchar(20) NOT NULL CHECK (method IN ('cash', 'card', 'bank_transfer', 'other')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reference varchar(100),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON farmacia.sale_payments (sale_id);
