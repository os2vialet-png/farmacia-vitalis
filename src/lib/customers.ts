import { z } from "zod";

export const CONSENT_TYPES = [
  "personal_data_processing",
  "commercial_whatsapp",
  "commercial_email",
  "commercial_sms",
] as const;

export type ConsentType = (typeof CONSENT_TYPES)[number];

export const CONSENT_LABELS: Record<ConsentType, string> = {
  personal_data_processing: "Tratamiento de datos personales (aviso de privacidad)",
  commercial_whatsapp: "Comunicaciones comerciales por WhatsApp",
  commercial_email: "Comunicaciones comerciales por correo",
  commercial_sms: "Comunicaciones comerciales por SMS",
};

const optionalText = (max: number) =>
  z.string().trim().max(max).optional().transform((value) => (value ? value : null));

export const customerCreateSchema = z.object({
  fullName: z.string().trim().min(2, "El nombre debe tener al menos 2 caracteres.").max(160),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,30}$/, "El teléfono no es válido.")
    .optional()
    .transform((value) => (value ? value : null)),
  email: z
    .string()
    .trim()
    .max(254)
    .optional()
    .transform((value) => (value ? value.toLowerCase() : null))
    .refine((value) => value === null || z.email().safeParse(value).success, "El correo no es válido."),
  documentNumber: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{6,30}$/, "El documento debe tener entre 6 y 30 caracteres alfanuméricos.")
    .optional()
    .transform((value) => (value ? value.toUpperCase() : null)),
  address: optionalText(300),
  notes: optionalText(1000),
  // Aviso de privacidad: obligatorio para registrar a una persona.
  privacyAccepted: z.literal(true, { message: "Debes confirmar el aviso de tratamiento de datos." }),
  // Consentimientos comerciales: solo se registran si la persona respondió.
  commercialConsents: z
    .array(
      z.object({
        type: z.enum(["commercial_whatsapp", "commercial_email", "commercial_sms"]),
        granted: z.boolean(),
      }),
    )
    .max(3)
    .optional()
    .default([]),
});

export const customerUpdateSchema = z.object({
  fullName: z.string().trim().min(2).max(160).optional(),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,30}$/)
    .nullable()
    .optional(),
  email: z
    .string()
    .trim()
    .max(254)
    .nullable()
    .optional()
    .refine((value) => value === null || value === undefined || value === "" || z.email().safeParse(value).success, "El correo no es válido."),
  address: z.string().trim().max(300).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const consentSchema = z.object({
  consentType: z.enum(CONSENT_TYPES),
  granted: z.boolean(),
  source: z.enum(["manual", "pos", "web", "whatsapp", "in_store"]).default("manual"),
});

/** Oculta el documento: solo se muestran los últimos 3 caracteres. */
export function maskDocument(value: string | null): string | null {
  if (!value) return null;
  return `•••${value.slice(-3)}`;
}
