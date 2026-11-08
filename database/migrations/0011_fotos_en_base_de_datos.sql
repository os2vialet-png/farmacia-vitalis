-- Fotos de productos guardadas en la base de datos (no en el disco del servidor), para que
-- sobrevivan en servicios de alojamiento cuyo disco se borra en cada actualización. Aditiva.
CREATE TABLE IF NOT EXISTS farmacia.product_image_files (
  product_id uuid PRIMARY KEY REFERENCES farmacia.catalog_products(id) ON DELETE CASCADE,
  content_type varchar(40) NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  data bytea NOT NULL CHECK (octet_length(data) BETWEEN 1 AND 3145728),
  updated_at timestamptz NOT NULL DEFAULT now()
);
