import "server-only";

import { z } from "zod";
import type { PoolClient } from "pg";
import { writeAudit } from "@/src/lib/audit";
import { BusinessError } from "@/src/lib/errors";
import { percentToRate } from "@/src/lib/catalog";

const optional = (max: number) =>
  z.string().trim().max(max).optional().transform((value) => (value ? value : null));

export const productCreateSchema = z.object({
  productName: z.string().trim().min(2, "El nombre debe tener al menos 2 caracteres.").max(200),
  brandName: optional(120),
  dosageForm: optional(120),
  strength: optional(60),
  presentation: optional(160),
  saleUnit: optional(60),
  sanitaryRegistration: optional(40),
  taxPercent: z.number().min(0).max(100).nullable().optional(),
  isPrescription: z.boolean().optional().default(false),
});

export type ProductCreateInput = z.input<typeof productCreateSchema>;

export function normalizeProductName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Crea un producto en el catálogo. Entra activo para poder comprarlo, pero
 * pendiente de verificación: no se vende hasta que un farmacéutico lo verifique.
 */
export async function createCatalogProduct(
  client: PoolClient,
  rawInput: unknown,
  actorUserId: string,
  ip: string | null,
): Promise<{ id: string; productName: string }> {
  const parsed = productCreateSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new BusinessError(parsed.error.issues[0]?.message ?? "Datos del producto no válidos.", 400);
  }

  const data = parsed.data;
  const normalized = normalizeProductName(data.productName);

  const duplicate = await client.query<{ id: string }>(
    `SELECT id FROM farmacia.catalog_products
     WHERE normalized_name = $1
       AND COALESCE(sanitary_registration, '') = COALESCE($2, '')
       AND COALESCE(lower(strength), '') = COALESCE(lower($3), '')
       AND duplicate_of_product_id IS NULL
     LIMIT 1`,
    [normalized, data.sanitaryRegistration, data.strength],
  );

  if (duplicate.rows.length > 0) {
    throw new BusinessError("Ya existe un producto con ese nombre, registro y concentración.", 409);
  }

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO farmacia.catalog_products
       (product_name, normalized_name, brand_name, dosage_form, strength, presentation, sale_unit,
        sanitary_registration, tax_rate, is_prescription, verification_status, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', TRUE)
     RETURNING id`,
    [
      data.productName,
      normalized,
      data.brandName,
      data.dosageForm,
      data.strength,
      data.presentation,
      data.saleUnit,
      data.sanitaryRegistration,
      percentToRate(data.taxPercent),
      data.isPrescription,
    ],
  );

  const id = inserted.rows[0].id;

  await writeAudit(client, {
    actorUserId,
    action: "catalog.create",
    entity: "catalog_product",
    entityId: id,
    newValues: { ...data, verificationStatus: "pending" },
    ip,
  });

  return { id, productName: data.productName };
}
