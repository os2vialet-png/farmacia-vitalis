import { NextRequest, NextResponse } from "next/server";
import { db } from "@/src/lib/db";
import { destroySession, getSession } from "@/src/lib/auth/session";
import { writeAudit } from "@/src/lib/audit";
import { clientIp } from "@/src/lib/http";

export async function POST(request: NextRequest) {
  try {
    const session = await getSession();

    await destroySession();

    if (session) {
      await writeAudit(db, {
        actorUserId: session.user.id,
        action: "logout",
        entity: "user",
        entityId: session.user.id,
        ip: clientIp(request),
      });
    }

    return NextResponse.json({
      success: true,
      message: "Sesión cerrada correctamente.",
      redirectTo: "/login",
    });
  } catch (error) {
    console.error("Error al cerrar sesión:", error);

    return NextResponse.json(
      { success: false, error: "No fue posible cerrar la sesión." },
      { status: 500 },
    );
  }
}
