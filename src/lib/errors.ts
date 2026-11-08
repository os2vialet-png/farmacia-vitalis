/**
 * Error de negocio seguro para mostrar al usuario.
 * Las rutas lo convierten en respuesta HTTP con su estado; cualquier otro error se
 * registra en el servidor y responde con un mensaje genérico.
 */
export class BusinessError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "BusinessError";
    this.status = status;
  }
}

export function isBusinessError(error: unknown): error is BusinessError {
  return error instanceof BusinessError;
}

/** Código de PostgreSQL para violación de unicidad. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}
