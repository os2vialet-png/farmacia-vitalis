
BEGIN;

-- Laboratorios, fabricantes y titulares de registros sanitarios
CREATE TABLE IF NOT EXISTS farmacia.laboratories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    normalized_name VARCHAR(200) NOT NULL UNIQUE,
    country VARCHAR(100),
    website TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Principios activos
CREATE TABLE IF NOT EXISTS farmacia.active_ingredients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    normalized_name VARCHAR(200) NOT NULL UNIQUE,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fuentes de información utilizadas para importar y verificar productos
CREATE TABLE IF NOT EXISTS farmacia.catalog_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(60) NOT NULL UNIQUE,
    name VARCHAR(200) NOT NULL,
    source_type VARCHAR(40) NOT NULL
        CHECK (source_type IN ('official_registry', 'official_catalog', 'supplier', 'manual', 'other')),
    source_url TEXT,
    update_frequency VARCHAR(100),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Historial de importaciones
CREATE TABLE IF NOT EXISTS farmacia.catalog_import_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id UUID REFERENCES farmacia.catalog_sources(id),
    file_name VARCHAR(255),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    records_received INTEGER NOT NULL DEFAULT 0,
    records_created INTEGER NOT NULL DEFAULT 0,
    records_updated INTEGER NOT NULL DEFAULT 0,
    records_rejected INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'processing'
        CHECK (status IN ('processing', 'completed', 'failed')),
    error_details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Catálogo comercial unificado.
-- Cada registro representa una presentación comercial concreta.
CREATE TABLE IF NOT EXISTS farmacia.catalog_products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    product_name VARCHAR(300) NOT NULL,
    normalized_name VARCHAR(300) NOT NULL,
    brand_name VARCHAR(200),

    manufacturer_id UUID REFERENCES farmacia.laboratories(id),
    registration_holder_id UUID REFERENCES farmacia.laboratories(id),

    sanitary_registration VARCHAR(100),
    dosage_form VARCHAR(150),
    strength VARCHAR(150),
    presentation VARCHAR(250),

    sale_unit VARCHAR(50) NOT NULL DEFAULT 'unidad',
    units_per_package NUMERIC(12,3) NOT NULL DEFAULT 1
        CHECK (units_per_package > 0),

    barcode VARCHAR(100),
    atc_code VARCHAR(30),

    is_prescription BOOLEAN,
    is_controlled BOOLEAN NOT NULL DEFAULT FALSE,

    verification_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (verification_status IN ('pending', 'verified', 'needs_review')),

    source_id UUID REFERENCES farmacia.catalog_sources(id),
    source_batch_id UUID REFERENCES farmacia.catalog_import_batches(id),
    source_external_id VARCHAR(150),
    source_data JSONB,

    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Un producto puede contener uno o varios principios activos
CREATE TABLE IF NOT EXISTS farmacia.product_ingredients (
    product_id UUID NOT NULL
        REFERENCES farmacia.catalog_products(id) ON DELETE CASCADE,
    ingredient_id UUID NOT NULL
        REFERENCES farmacia.active_ingredients(id),
    ingredient_strength VARCHAR(150),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (product_id, ingredient_id)
);

-- Precio comercial por producto y sucursal.
-- No se asignan precios inventados durante la importación.
CREATE TABLE IF NOT EXISTS farmacia.product_branch_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id UUID NOT NULL
        REFERENCES farmacia.catalog_products(id),
    branch_id UUID NOT NULL
        REFERENCES farmacia.branches(id),
    sale_price NUMERIC(12,2) NOT NULL
        CHECK (sale_price >= 0),
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    effective_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        effective_until IS NULL
        OR effective_until > effective_from
    )
);

-- Índices para búsquedas rápidas
CREATE INDEX IF NOT EXISTS idx_catalog_products_name
    ON farmacia.catalog_products (normalized_name);

CREATE INDEX IF NOT EXISTS idx_catalog_products_brand
    ON farmacia.catalog_products (brand_name);

CREATE INDEX IF NOT EXISTS idx_catalog_products_barcode
    ON farmacia.catalog_products (barcode)
    WHERE barcode IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_catalog_products_registration
    ON farmacia.catalog_products (sanitary_registration)
    WHERE sanitary_registration IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_catalog_products_atc
    ON farmacia.catalog_products (atc_code)
    WHERE atc_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_catalog_products_active
    ON farmacia.catalog_products (is_active, verification_status);

CREATE INDEX IF NOT EXISTS idx_product_ingredients_ingredient
    ON farmacia.product_ingredients (ingredient_id);

CREATE INDEX IF NOT EXISTS idx_branch_prices_product
    ON farmacia.product_branch_prices (product_id, branch_id);

CREATE INDEX IF NOT EXISTS idx_catalog_batches_source
    ON farmacia.catalog_import_batches (source_id, started_at DESC);

-- Fuentes oficiales iniciales
INSERT INTO farmacia.catalog_sources
    (code, name, source_type, source_url, update_frequency)
VALUES
    (
        'DIGEMAPS_REGISTRY',
        'Registro Sanitario de Productos Farmacéuticos - DIGEMAPS',
        'official_registry',
        'https://www.datos.gov.do/dataset/registro-sanitario-de-productos-farmaceuticos',
        'Actualización periódica'
    ),
    (
        'CUADRO_BASICO_RD',
        'Cuadro Básico de Medicamentos Esenciales de República Dominicana',
        'official_catalog',
        NULL,
        'Según publicación oficial'
    ),
    (
        'PROMESE_CAL',
        'Listado de precios de Farmacias del Pueblo - PROMESE/CAL',
        'official_catalog',
        'https://www.datos.gov.do/dataset/listado-de-precios-en-las-farmacias-del-pueblo-promese-cal',
        'Según publicación oficial'
    )
ON CONFLICT (code) DO NOTHING;

COMMIT;
