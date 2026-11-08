-- 0008: foto opcional por producto del catálogo.
-- Aditiva. La foto la agrega el personal (foto real del producto o del suplidor)
-- o una URL del fabricante; nunca se genera una imagen automática.

ALTER TABLE farmacia.catalog_products
  ADD COLUMN IF NOT EXISTS image_url TEXT;

ALTER TABLE farmacia.catalog_products
  DROP CONSTRAINT IF EXISTS catalog_products_image_url_len_check;

ALTER TABLE farmacia.catalog_products
  ADD CONSTRAINT catalog_products_image_url_len_check
  CHECK (image_url IS NULL OR length(image_url) <= 1000)
  NOT VALID;
