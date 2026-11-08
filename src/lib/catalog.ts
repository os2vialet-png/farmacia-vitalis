import { z } from "zod";

export const catalogUpdateSchema = z.object({
  brandName: z.string().trim().max(120).nullable().optional(),
  strength: z.string().trim().max(60).nullable().optional(),
  presentation: z.string().trim().max(160).nullable().optional(),
  saleUnit: z.string().trim().min(1).max(60).nullable().optional(),
  // Porcentaje (0 a 100). null = no configurado (se trata como exento).
  taxPercent: z.number().min(0).max(100).nullable().optional(),
  isActive: z.boolean().optional(),
  isPrescription: z.boolean().optional(),
  isControlled: z.boolean().optional(),
});

export const verifySchema = z.object({
  status: z.enum(["verified", "needs_review", "pending"]),
  evidenceType: z.enum(["sanitary_registry", "manual_review"]),
  evidenceReference: z.string().trim().min(3, "Indica la referencia de la evidencia.").max(200),
  notes: z.string().trim().max(500).optional(),
});

export const priceSchema = z.object({
  branchId: z.string().uuid(),
  salePrice: z.number().positive("El precio debe ser mayor que cero.").max(100000000),
});

/** Convierte el porcentaje de la interfaz a la fracción que se guarda (0.18 para 18 %). */
export function percentToRate(percent: number | null | undefined): string | null {
  if (percent === null || percent === undefined) return null;
  return (percent / 100).toFixed(4);
}
