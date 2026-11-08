BEGIN;

CREATE TABLE IF NOT EXISTS farmacia.suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(180) NOT NULL,
    commercial_name VARCHAR(180),
    tax_id VARCHAR(40),
    contact_name VARCHAR(160),
    phone VARCHAR(40),
    email VARCHAR(180),
    address TEXT,
    payment_terms VARCHAR(120),
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_suppliers_name
ON farmacia.suppliers (LOWER(name));

CREATE TABLE IF NOT EXISTS farmacia.purchase_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    branch_id UUID NOT NULL REFERENCES farmacia.branches(id),
    supplier_id UUID NOT NULL REFERENCES farmacia.suppliers(id),
    order_number VARCHAR(50) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ordered', 'partially_received', 'received', 'cancelled')),
    order_date DATE NOT NULL DEFAULT CURRENT_DATE,
    expected_date DATE,
    currency VARCHAR(3) NOT NULL DEFAULT 'DOP',
    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    total_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    notes TEXT,
    created_by UUID REFERENCES farmacia.users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (branch_id, order_number)
);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_branch_date
ON farmacia.purchase_orders (branch_id, order_date DESC);

CREATE INDEX IF NOT EXISTS idx_purchase_orders_status
ON farmacia.purchase_orders (branch_id, status);

CREATE TABLE IF NOT EXISTS farmacia.purchase_order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_order_id UUID NOT NULL
        REFERENCES farmacia.purchase_orders(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES farmacia.catalog_products(id),
    quantity_ordered INTEGER NOT NULL CHECK (quantity_ordered > 0),
    quantity_received INTEGER NOT NULL DEFAULT 0
        CHECK (quantity_received >= 0),
    unit_cost NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
    line_total NUMERIC(14,2) NOT NULL CHECK (line_total >= 0),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (quantity_received <= quantity_ordered),
    UNIQUE (purchase_order_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_purchase_items_order
ON farmacia.purchase_order_items (purchase_order_id);

CREATE TABLE IF NOT EXISTS farmacia.purchase_receipts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_order_id UUID NOT NULL
        REFERENCES farmacia.purchase_orders(id),
    branch_id UUID NOT NULL REFERENCES farmacia.branches(id),
    receipt_number VARCHAR(60) NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_by UUID REFERENCES farmacia.users(id),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (branch_id, receipt_number)
);

CREATE TABLE IF NOT EXISTS farmacia.purchase_receipt_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id UUID NOT NULL
        REFERENCES farmacia.purchase_receipts(id) ON DELETE CASCADE,
    purchase_order_item_id UUID NOT NULL
        REFERENCES farmacia.purchase_order_items(id),
    lot_id UUID REFERENCES farmacia.inventory_lots(id),
    lot_number VARCHAR(100) NOT NULL,
    expiration_date DATE NOT NULL,
    quantity_received INTEGER NOT NULL CHECK (quantity_received > 0),
    unit_cost NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_receipts_order
ON farmacia.purchase_receipts (purchase_order_id, received_at DESC);

COMMIT;