import "server-only";

/** Acepta el pool o un cliente de transacción. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

export type AuditEntry = {
  actorUserId: string | null;
  branchId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  ip?: string | null;
};

/**
 * Registra una acción sensible en farmacia.audit_logs.
 * Debe llamarse dentro de la misma transacción que la operación auditada
 * para que no exista operación sin registro ni registro sin operación.
 */
export async function writeAudit(executor: Queryable, entry: AuditEntry): Promise<void> {
  await executor.query(
    `INSERT INTO farmacia.audit_logs
       (actor_user_id, branch_id, action, entity, entity_id, old_values, new_values, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::inet)`,
    [
      entry.actorUserId,
      entry.branchId ?? null,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      entry.oldValues === undefined ? null : JSON.stringify(entry.oldValues),
      entry.newValues === undefined ? null : JSON.stringify(entry.newValues),
      entry.ip ?? null,
    ],
  );
}
