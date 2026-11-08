CREATE TABLE IF NOT EXISTS farmacia.catalog_product_registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID REFERENCES farmacia.catalog_products(id) ON DELETE SET NULL,
    source_id UUID NOT NULL REFERENCES farmacia.catalog_sources(id),
    source_batch_id UUID REFERENCES farmacia.catalog_import_batches(id),

    source_record_hash CHAR(64) NOT NULL,
    registration_request VARCHAR(100),
    sanitary_registration VARCHAR(100),
    product_name VARCHAR(500),
    generic_name VARCHAR(500),
    active_ingredient_text TEXT,
    manufacturer_name VARCHAR(500),
    distributor_name VARCHAR(500),
    representative_name VARCHAR(500),
    package_description TEXT,
    dosage_form TEXT,
    primary_container_specification TEXT,
    expiration_date DATE,
    registration_status VARCHAR(100),
    product_type VARCHAR(150),
    application_year INTEGER,
    application_month VARCHAR(30),

    source_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT uq_catalog_registration_source_hash
        UNIQUE (source_id, source_record_hash)
);

CREATE INDEX IF NOT EXISTS idx_catalog_registrations_number
    ON farmacia.catalog_product_registrations (sanitary_registration);

CREATE INDEX IF NOT EXISTS idx_catalog_registrations_name
    ON farmacia.catalog_product_registrations (product_name);

CREATE INDEX IF NOT EXISTS idx_catalog_registrations_status
    ON farmacia.catalog_product_registrations (registration_status, product_type);

CREATE INDEX IF NOT EXISTS idx_catalog_registrations_product
    ON farmacia.catalog_product_registrations (product_id);

CREATE INDEX IF NOT EXISTS idx_catalog_registrations_batch
    ON farmacia.catalog_product_registrations (source_batch_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_catalog_products_source_external
    ON farmacia.catalog_products (source_id, source_external_id)
    WHERE source_id IS NOT NULL AND source_external_id IS NOT NULL;
