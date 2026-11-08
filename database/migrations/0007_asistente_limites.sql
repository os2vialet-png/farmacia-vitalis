-- 0007: límite de uso de los asistentes persistido en la base de datos.
-- Aditiva. Antes el conteo vivía en memoria del proceso: al reiniciar el servidor se
-- reiniciaba y, con varias instancias, cada una llevaba su propio conteo.

CREATE TABLE IF NOT EXISTS farmacia.assistant_rate_limits (
  key varchar(120) PRIMARY KEY,
  window_start timestamptz NOT NULL DEFAULT now(),
  window_seconds int NOT NULL,
  hit_count int NOT NULL DEFAULT 0
);
