import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";

type Context = { params: Promise<{ id: string }> };

const ALLOWED_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const imagePayloadSchema = z.object({
  imageUrl: z
    .string()
    .trim()
    .min(1, "Indica la dirección de la imagen o elimina la foto actual.")
    .max(1000, "La dirección de la imagen es demasiado larga."),
});

/**
 * Foto del producto: subida de un archivo real o una dirección del fabricante.
 * `POST` (multipart `image`), `PUT` JSON con `imageUrl`, `DELETE` para quitarla.
 * La imagen nunca se genera ni se inventa; es una foto que el personal carga.
 * Las fotos subidas se guardan en la base (farmacia.product_image_files) y se sirven con `GET`,
 * así no se pierden cuando el servidor se reinstala.
 */

/** Sirve la foto subida de un producto. */
export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) return new NextResponse(null, { status: 404 });
  const result = await db.query<{ content_type: string; data: Buffer }>(
    `SELECT content_type, data FROM farmacia.product_image_files WHERE product_id = $1`,
    [id],
  );
  const image = result.rows[0];
  if (!image) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(image.data), {
    headers: {
      "Content-Type": image.content_type,
      // La dirección cambia (?v=) con cada foto nueva: se puede guardar en caché.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readOldImage(id: string): Promise<string | null> {
  const client = await db.connect();
  try {
    const current = await client.query<{ image_url: string | null }>(
      `SELECT image_url FROM farmacia.catalog_products WHERE id = $1`,
      [id],
    );
    return current.rows[0]?.image_url ?? null;
  } finally {
    client.release();
  }
}

async function applyImage(
  productId: string,
  nextImage: string | null,
  actorUserId: string,
  action: string,
  details: Record<string, unknown>,
  ip: string | null,
  upload?: { contentType: string; bytes: Buffer },
): Promise<NextResponse> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<{ image_url: string | null }>(
      `SELECT image_url FROM farmacia.catalog_products WHERE id = $1 FOR UPDATE`,
      [productId],
    );
    if (current.rows.length === 0) {
      await client.query("ROLLBACK");
      return jsonError("El producto no existe.", 404);
    }
    const previous = current.rows[0].image_url;
    if (upload) {
      await client.query(
        `INSERT INTO farmacia.product_image_files (product_id, content_type, data, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (product_id) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, updated_at = NOW()`,
        [productId, upload.contentType, upload.bytes],
      );
    } else {
      await client.query(`DELETE FROM farmacia.product_image_files WHERE product_id = $1`, [productId]);
    }
    await client.query(
      `UPDATE farmacia.catalog_products SET image_url = $2, updated_at = NOW() WHERE id = $1`,
      [productId, nextImage],
    );
    await writeAudit(client, {
      actorUserId,
      action,
      entity: "catalog_product",
      entityId: productId,
      oldValues: { image_url: previous },
      newValues: { image_url: nextImage, ...details },
      ip,
    });
    await client.query("COMMIT");
    return NextResponse.json({ success: true, imageUrl: nextImage });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const access = await authorize("catalog.update");
    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de producto inválido.", 400);
    }

    const form = await request.formData().catch(() => null);
    const file = form?.get("image");
    if (!form || !(file instanceof File)) {
      return jsonError("Adjunta la foto del producto.", 400);
    }
    // `type` y `name` vienen del cliente: solo se confía en ellos tras validarlos aquí.
    if (!ALLOWED_TYPES[file.type]) {
      return jsonError("Formato de imagen no admitido. Usa JPG, PNG o WEBP.", 415);
    }
    if (file.size <= 0 || file.size > 3 * 1024 * 1024) {
      return jsonError("La imagen debe pesar menos de 3 MB.", 413);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length !== file.size) {
      return jsonError("La imagen llegó incompleta. Intenta de nuevo.", 400);
    }

    return await applyImage(
      id,
      `/api/catalog/${id}/image?v=${Date.now()}`,
      access.session.user.id,
      "catalog.image_update",
      { origin: "upload", bytes: bytes.length },
      clientIp(request),
      { contentType: file.type, bytes },
    );
  } catch (error) {
    console.error("Error subiendo imagen de producto:", error);
    return jsonError("No fue posible guardar la foto del producto.", 500);
  }
}

export async function PUT(request: NextRequest, context: Context) {
  try {
    const access = await authorize("catalog.update");
    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de producto inválido.", 400);
    }

    const body: unknown = await request.json().catch(() => null);
    const parsed = imagePayloadSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(parsed.error.issues[0]?.message ?? "Datos no válidos.", 400);
    }

    if (!/^https?:\/\/\S+$/i.test(parsed.data.imageUrl)) {
      return jsonError("La dirección de la imagen debe iniciar con http o https.", 400);
    }

    return await applyImage(
      id,
      parsed.data.imageUrl,
      access.session.user.id,
      "catalog.image_update",
      { origin: "url" },
      clientIp(request),
    );
  } catch (error) {
    console.error("Error guardando imagen por URL:", error);
    return jsonError("No fue posible guardar la foto del producto.", 500);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  try {
    const access = await authorize("catalog.update");
    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) {
      return jsonError("Identificador de producto inválido.", 400);
    }

    const old = await readOldImage(id);
    if (!old) {
      return jsonError("El producto no tiene foto.", 409);
    }

    return await applyImage(
      id,
      null,
      access.session.user.id,
      "catalog.image_remove",
      {},
      clientIp(request),
    );
  } catch (error) {
    console.error("Error quitando imagen de producto:", error);
    return jsonError("No fue posible quitar la foto del producto.", 500);
  }
}
