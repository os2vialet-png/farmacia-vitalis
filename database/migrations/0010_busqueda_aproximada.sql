-- Búsqueda aproximada de productos (tolera errores de escritura: «winnasord» → WINASORB).
-- Aditiva: instala la extensión pg_trgm (de confianza, incluida con PostgreSQL) y crea índices.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA farmacia;

CREATE INDEX IF NOT EXISTS catalog_products_name_trgm_idx
  ON farmacia.catalog_products USING gin (normalized_name farmacia.gin_trgm_ops);

CREATE INDEX IF NOT EXISTS catalog_products_ingredient_trgm_idx
  ON farmacia.catalog_products USING gin ((upper(source_data->>'active_ingredient_text')) farmacia.gin_trgm_ops);
