BEGIN;
SET LOCAL statement_timeout = '120s';

-- Los datos comerciales desconocidos deben permanecer NULL.
ALTER TABLE farmacia.catalog_products
    ALTER COLUMN sale_unit DROP NOT NULL,
    ALTER COLUMN sale_unit DROP DEFAULT,
    ALTER COLUMN units_per_package DROP NOT NULL,
    ALTER COLUMN units_per_package DROP DEFAULT,
    ALTER COLUMN is_controlled DROP NOT NULL,
    ALTER COLUMN is_controlled DROP DEFAULT;

-- Identidades conservadoras para evitar fusionar formulaciones distintas.
CREATE TEMP TABLE tmp_digemaps_all ON COMMIT DROP AS
SELECT
    r.id AS history_id,
    r.source_id,
    r.source_batch_id,
    r.product_name,
    r.generic_name,
    r.active_ingredient_text,
    r.manufacturer_name,
    r.distributor_name,
    r.representative_name,
    r.sanitary_registration,
    r.registration_request,
    r.dosage_form,
    r.package_description,
    r.primary_container_specification,
    r.expiration_date,
    r.registration_status,
    r.product_type,
    r.source_data,
    md5(concat_ws(chr(31),
        trim(regexp_replace(lower(replace(coalesce(r.product_name,''), chr(160),' ')), '[^[:alnum:]]+', ' ', 'g')),
        trim(regexp_replace(lower(replace(coalesce(r.generic_name,''), chr(160),' ')), '[^[:alnum:]]+', ' ', 'g')),
        trim(regexp_replace(lower(replace(coalesce(r.active_ingredient_text,''), chr(160),' ')), '[^[:alnum:]]+', ' ', 'g')),
        trim(regexp_replace(lower(replace(coalesce(r.dosage_form,''), chr(160),' ')), '[^[:alnum:]]+', ' ', 'g')),
        trim(regexp_replace(lower(replace(coalesce(r.package_description,''), chr(160),' ')), '[^[:alnum:]]+', ' ', 'g')),
        trim(regexp_replace(lower(replace(coalesce(r.primary_container_specification,''), chr(160),' ')), '[^[:alnum:]]+', ' ', 'g')),
        trim(regexp_replace(lower(replace(coalesce(r.manufacturer_name,''), chr(160),' ')), '[^[:alnum:]]+', ' ', 'g'))
    )) AS group_key
FROM farmacia.catalog_product_registrations r
JOIN farmacia.catalog_sources s ON s.id = r.source_id
WHERE s.code = 'DIGEMAPS_REGISTRY';

-- Un representante por identidad, priorizando el registro con vencimiento más lejano.
CREATE TEMP TABLE tmp_digemaps_candidates ON COMMIT DROP AS
SELECT DISTINCT ON (group_key) *
FROM tmp_digemaps_all
WHERE product_type = 'MEDICAMENTOS'
  AND upper(trim(coalesce(registration_status,''))) = 'VIGENTE'
  AND expiration_date >= CURRENT_DATE
  AND NULLIF(trim(product_name),'') IS NOT NULL
ORDER BY group_key, expiration_date DESC NULLS LAST, history_id;

-- Crear candidatos internos, no visibles para clientes ni habilitados para venta.
INSERT INTO farmacia.catalog_products (
    product_name,
    normalized_name,
    brand_name,
    sanitary_registration,
    dosage_form,
    presentation,
    sale_unit,
    units_per_package,
    is_prescription,
    is_controlled,
    verification_status,
    source_id,
    source_batch_id,
    source_external_id,
    source_data,
    is_active
)
SELECT
    trim(c.product_name),
    trim(regexp_replace(lower(replace(c.product_name, chr(160),' ')), '[^[:alnum:]]+', ' ', 'g')),
    NULL,
    NULLIF(trim(c.sanitary_registration),''),
    NULLIF(trim(c.dosage_form),''),
    NULLIF(concat_ws(' | ',
        NULLIF(trim(c.package_description),''),
        NULLIF(trim(c.primary_container_specification),'')
    ),''),
    NULL,
    NULL,
    NULL,
    NULL,
    'needs_review',
    c.source_id,
    c.source_batch_id,
    'DIGEMAPS:' || c.group_key,
    coalesce(c.source_data,'{}'::jsonb) ||
    jsonb_build_object(
        'generic_name', c.generic_name,
        'active_ingredient_text', c.active_ingredient_text,
        'manufacturer_name', c.manufacturer_name,
        'distributor_name', c.distributor_name,
        'representative_name', c.representative_name,
        'package_description', c.package_description,
        'primary_container_specification', c.primary_container_specification,
        'registration_request', c.registration_request,
        'expiration_date', c.expiration_date,
        'registration_status', c.registration_status,
        'catalog_origin', 'DIGEMAPS_REGISTRY'
    ),
    false
FROM tmp_digemaps_candidates c
ON CONFLICT DO NOTHING;

-- Relacionar los registros históricos que coincidan exactamente
-- con la identidad conservadora de cada candidato.
UPDATE farmacia.catalog_product_registrations r
SET product_id = p.id
FROM tmp_digemaps_all a
JOIN farmacia.catalog_products p
  ON p.source_id = a.source_id
 AND p.source_external_id = 'DIGEMAPS:' || a.group_key
WHERE r.id = a.history_id
  AND r.product_id IS DISTINCT FROM p.id;

COMMIT;

-- Resumen de la carga.
SELECT
    COUNT(*) AS candidatos_creados,
    COUNT(*) FILTER (WHERE verification_status = 'needs_review') AS pendientes_revision,
    COUNT(*) FILTER (WHERE is_active = false) AS desactivados
FROM farmacia.catalog_products
WHERE source_external_id LIKE 'DIGEMAPS:%';

SELECT
    COUNT(*) AS registros_historicos_relacionados
FROM farmacia.catalog_product_registrations
WHERE product_id IS NOT NULL;