import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { db } from "@/src/lib/db";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { writeAudit } from "@/src/lib/audit";
import { clientIp, jsonError } from "@/src/lib/http";

type Context = { params: Promise<{ id: string }> };

const UPLOAD_DIR = resolve(process.cwd(), "public", "uploads", "productos");

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
 */

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

async function removeLocalUpload(url: string | null): Promise<void> {
  if (!url || !url.startsWith("/uploads/productos/")) return;
  const file = basename(url);
  if (!file || file.includes("/")) return;
  await unlink(join(UPLOAD_DIR, file)).catch(() => undefined);
}

async function applyImage(
  productId: string,
  nextImage: string | null,
  actorUserId: string,
  action: string,
  details: Record<string, unknown>,
  ip: string | null,
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
    client.release();
    await removeLocalUpload(previous);
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
    const extension = ALLOWED_TYPES[file.type];
    if (!extension) {
      return jsonError("Formato de imagen no admitido. Usa JPG, PNG o WEBP.", 415);
    }
    if (file.size <= 0 || file.size > 3 * 1024 * 1024) {
      return jsonError("La imagen debe pesar menos de 3 MB.", 413);
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length !== file.size) {
      return jsonError("La imagen llegó incompleta. Intenta de nuevo.", 400);
    }

    await mkdir(UPLOAD_DIR, { recursive: true });
    const fileName = `${id}-${Date.now()}.${extension}`;
    await writeFile(join(UPLOAD_DIR, fileName), bytes);

    return await applyImage(
      id,
      `/uploads/productos/${fileName}`,
      access.session.user.id,
      "catalog.image_update",
      { origin: "upload" },
      clientIp(request),
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
