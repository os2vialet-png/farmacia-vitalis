-- 0009: historial de acciones del asistente del dueño, para poder deshacerlas.
-- Aditiva.

CREATE TABLE IF NOT EXISTS farmacia.owner_assistant_actions (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES farmacia.users(id),
  action varchar(40) NOT NULL,
  summary text NOT NULL,
  undo jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_at timestamptz,
  undone_by uuid REFERENCES farmacia.users(id)
);

CREATE INDEX IF NOT EXISTS idx_owner_assistant_actions_user
  ON farmacia.owner_assistant_actions (user_id, created_at DESC)
  WHERE undone_at IS NULL;
