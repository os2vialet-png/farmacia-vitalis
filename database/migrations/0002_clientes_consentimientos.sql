-- 0002: clientes y consentimientos separados.
-- Aditiva. Los consentimientos son historial de solo inserción.

CREATE TABLE IF NOT EXISTS farmacia.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name varchar(160) NOT NULL CHECK (btrim(full_name) <> ''),
  phone varchar(30),
  email varchar(254),
  document_number varchar(30),
  address text,
  notes text,
  is_active boolean NOT NULL DEFAULT TRUE,
  created_by uuid REFERENCES farmacia.users(id),
  updated_by uuid REFERENCES farmacia.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_document
  ON farmacia.customers (document_number)
  WHERE document_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_customers_name
  ON farmacia.customers (lower(full_name));

CREATE INDEX IF NOT EXISTS idx_customers_phone
  ON farmacia.customers (phone);

CREATE TABLE IF NOT EXISTS farmacia.customer_consents (
  id bigserial PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES farmacia.customers(id) ON DELETE RESTRICT,
  consent_type varchar(60) NOT NULL CHECK (consent_type IN (
    'personal_data_processing',
    'commercial_whatsapp',
    'commercial_email',
    'commercial_sms'
  )),
  granted boolean NOT NULL,
  source varchar(40) NOT NULL DEFAULT 'manual',
  recorded_by uuid REFERENCES farmacia.users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_consents_lookup
  ON farmacia.customer_consents (customer_id, consent_type, recorded_at DESC);

-- Historial inmutable: no se permite modificar ni borrar consentimientos.
CREATE OR REPLACE FUNCTION farmacia.forbid_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'La tabla % es de solo inserción (historial auditable).', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_consents_immutable ON farmacia.customer_consents;
CREATE TRIGGER trg_customer_consents_immutable
  BEFORE UPDATE OR DELETE ON farmacia.customer_consents
  FOR EACH ROW EXECUTE FUNCTION farmacia.forbid_mutation();
