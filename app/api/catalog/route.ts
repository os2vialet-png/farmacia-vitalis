import { NextRequest, NextResponse } from "next/server";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { clientIp, jsonError } from "@/src/lib/http";
import { isBusinessError } from "@/src/lib/errors";
import { createCatalogProduct } from "@/src/lib/catalog-create";

/** Alta de un producto nuevo en el catálogo (queda pendiente de verificación). */
export async function POST(request: NextRequest) {
  let client;

  try {
    const access = await authorize("catalog.create");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const body: unknown = await request.json().catch(() => null);

    client = await db.connect();
    await client.query("BEGIN");
    const product = await createCatalogProduct(client, body, access.session.user.id, clientIp(request));
    await client.query("COMMIT");
    client.release();
    client = undefined;

    return NextResponse.json(
      { success: true, message: "Producto creado. Queda pendiente de verificación para poder venderse.", product },
      { status: 201 },
    );
  } catch (error) {
    if (client) await client.query("ROLLBACK").catch(() => undefined);
    if (isBusinessError(error)) return jsonError(error.message, error.status);
    console.error("Error creando producto:", error);
    return jsonError("No fue posible crear el producto.", 500);
  } finally {
    client?.release();
  }
}
