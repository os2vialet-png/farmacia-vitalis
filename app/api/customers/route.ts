import { NextRequest, NextResponse } from "next/server";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";
import { isUniqueViolation } from "@/src/lib/errors";
import { customerCreateSchema, maskDocument } from "@/src/lib/customers";

/** Búsqueda de clientes por nombre, teléfono o documento. El documento se devuelve enmascarado. */
export async function GET(request: NextRequest) {
  try {
    const access = await authorize("customers.view");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const term = (request.nextUrl.searchParams.get("q") ?? "").trim();

    if (term.length < 2) {
      return NextResponse.json({ success: true, customers: [] });
    }

    if (term.length > 80) {
      return jsonError("La búsqueda es demasiado larga.", 400);
    }

    const result = await db.query<{
      id: string;
      full_name: string;
      phone: string | null;
      document_number: string | null;
    }>(
      `SELECT id, full_name, phone, document_number
       FROM farmacia.customers
       WHERE is_active = TRUE
         AND (
           full_name ILIKE '%' || $1 || '%'
           OR COALESCE(phone, '') LIKE '%' || $1 || '%'
           OR COALESCE(document_number, '') = UPPER($1)
         )
       ORDER BY full_name
       LIMIT 20`,
      [term],
    );

    return NextResponse.json({
      success: true,
      customers: result.rows.map((row) => ({
        id: row.id,
        fullName: row.full_name,
        phone: row.phone,
        documentNumber: maskDocument(row.document_number),
      })),
    });
  } catch (error) {
    console.error("Error buscando clientes:", error);
    return jsonError("No fue posible buscar clientes.", 500);
  }
}

/** Registro de cliente nuevo, con consentimientos comerciales registrados por separado. */
export async function POST(request: NextRequest) {
  let client;

  try {
    const access = await authorize("customers.manage");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = customerCreateSchema.safeParse(body);

    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Datos del cliente no válidos.", 400);
    }

    const data = parsed.data;
    const session = access.session;

    client = await db.connect();
    await client.query("BEGIN");

    const created = await client.query<{ id: string }>(
      `INSERT INTO farmacia.customers
         (full_name, phone, email, document_number, address, notes, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING id`,
      [
        data.fullName,
        data.phone,
        data.email,
        data.documentNumber,
        data.address,
        data.notes,
        session.user.id,
      ],
    );

    const customerId = created.rows[0].id;

    await client.query(
      `INSERT INTO farmacia.customer_consents (customer_id, consent_type, granted, source, recorded_by)
       VALUES ($1, 'personal_data_processing', TRUE, 'manual', $2)`,
      [customerId, session.user.id],
    );

    for (const consent of data.commercialConsents) {
      await client.query(
        `INSERT INTO farmacia.customer_consents (customer_id, consent_type, granted, source, recorded_by)
         VALUES ($1, $2, $3, 'manual', $4)`,
        [customerId, consent.type, consent.granted, session.user.id],
      );
    }

    await writeAudit(client, {
      actorUserId: session.user.id,
      action: "customer.create",
      entity: "customer",
      entityId: customerId,
      newValues: {
        hasPhone: data.phone !== null,
        hasEmail: data.email !== null,
        hasDocument: data.documentNumber !== null,
        commercialConsents: data.commercialConsents,
      },
      ip: clientIp(request),
    });

    await client.query("COMMIT");
    // Conexión liberada tras confirmar: lo que sigue usa el pool sin retener esta conexión.
    client.release();
    client = undefined;

    return NextResponse.json({ success: true, id: customerId }, { status: 201 });
  } catch (error) {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined);
    }

    if (isUniqueViolation(error)) {
      return jsonError("Ya existe un cliente registrado con ese documento.", 409);
    }

    console.error("Error registrando cliente:", error);
    return jsonError("No fue posible registrar el cliente.", 500);
  } finally {
    client?.release();
  }
}
