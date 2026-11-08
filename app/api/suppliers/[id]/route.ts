import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize } from "@/src/lib/auth/permissions";

const schema = z.object({
  name: z.string().trim().min(2).max(180),
  commercialName: z.string().trim().max(180).nullable().optional(),
  taxId: z.string().trim().max(40).nullable().optional(),
  contactName: z.string().trim().max(160).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  email: z.string().trim().email().max(180).nullable().optional().or(z.literal("")),
  address: z.string().trim().max(2000).nullable().optional(),
  paymentTerms: z.string().trim().max(120).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  isActive: z.boolean().optional(),
});

type Context = { params: Promise<{ id: string }> };

function error(message: string, status: number) {
  return NextResponse.json({ success: false, error: message }, { status });
}

export async function PATCH(request: NextRequest, context: Context) {
  try {
    const access = await authorize("purchases.create");
    if (!access.authorized) {
      return error("No tienes autorización para modificar suplidores.", access.reason === "unauthenticated" ? 401 : 403);
    }

    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) {
      return error("Identificador de suplidor inválido.", 400);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      return error("Los datos enviados no son válidos.", 400);
    }

    const d = parsed.data;
    const result = await db.query(
      `UPDATE farmacia.suppliers SET
         name = $2,
         commercial_name = $3,
         tax_id = $4,
         contact_name = $5,
         phone = $6,
         email = $7,
         address = $8,
         payment_terms = $9,
         notes = $10,
         is_active = COALESCE($11, is_active),
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        id, d.name, d.commercialName || null, d.taxId || null,
        d.contactName || null, d.phone || null, d.email || null,
        d.address || null, d.paymentTerms || null, d.notes || null,
        d.isActive ?? null,
      ],
    );

    if (!result.rows.length) return error("El suplidor no existe.", 404);

    await db.query(
      `INSERT INTO farmacia.audit_logs (
         actor_user_id, action, entity, entity_id, new_values
       ) VALUES ($1, 'supplier.update', 'supplier', $2, $3)`,
      [access.session.user.id, id, JSON.stringify({
        name: d.name,
        isActive: d.isActive,
      })],
    );

    return NextResponse.json({ success: true, supplier: result.rows[0] });
  } catch (e) {
    console.error("PATCH supplier:", e);
    return error("No fue posible actualizar el suplidor.", 500);
  }
}