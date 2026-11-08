import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorize, authorizationMessage, authorizationStatus } from "@/src/lib/auth/permissions";
import { accessibleBranchIds } from "@/src/lib/access";
import { jsonError } from "@/src/lib/http";
import { REPORTS, REPORT_COLUMNS, runReport, type ReportKey } from "@/src/lib/reports";
import { COLUMN_LABELS, formatCsvCell } from "@/src/lib/report-format";
import { serializeCsv } from "@/src/lib/csv";

const querySchema = z.object({
  report: z.enum(Object.keys(REPORTS) as [ReportKey, ...ReportKey[]]),
  branchId: z.string().default("all"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.coerce.number().int().min(1).max(365).optional(),
  format: z.enum(["json", "csv"]).default("json"),
});

/**
 * Reportes desde PostgreSQL. Solo incluye sucursales donde la sesión tiene reports.view.
 * Pedir una sucursal fuera de ese alcance responde 403; no se filtra en silencio.
 * format=csv devuelve el archivo con BOM UTF-8 (abre directo en Excel).
 */
export async function GET(request: NextRequest) {
  try {
    const access = await authorize("reports.view");

    if (!access.authorized) {
      return jsonError(authorizationMessage(access.reason), authorizationStatus(access.reason));
    }

    const params = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));

    if (!params.success) {
      return jsonError("Revisa el reporte, el rango de fechas y la sucursal.", 400);
    }

    const allowed = await accessibleBranchIds(access.session, "reports.view");

    let branchIds = allowed;
    if (params.data.branchId !== "all") {
      if (!z.string().uuid().safeParse(params.data.branchId).success || !allowed.includes(params.data.branchId)) {
        return jsonError("No tienes acceso a los reportes de esa sucursal.", 403);
      }
      branchIds = [params.data.branchId];
    }

    if (params.data.from > params.data.to) {
      return jsonError("La fecha inicial no puede ser posterior a la final.", 400);
    }

    const rows = await runReport(params.data.report, {
      branchIds,
      from: params.data.from,
      to: params.data.to,
      days: params.data.days,
    });

    if (params.data.format === "csv") {
      const columns = REPORT_COLUMNS[params.data.report];
      const headers = columns.map((column) => COLUMN_LABELS[column] ?? column);
      const table = (rows as Array<Record<string, unknown>>).map((row) =>
        columns.map((column) => formatCsvCell(column, row[column])),
      );
      const csv = `\ufeff${serializeCsv(headers, table)}`;
      const filename = `reporte-${params.data.report}-${params.data.from}-${params.data.to}.csv`;

      return new NextResponse(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        },
      });
    }

    return NextResponse.json({ success: true, report: params.data.report, rows });
  } catch (error) {
    console.error("Error generando reporte:", error);
    return jsonError("No fue posible generar el reporte.", 500);
  }
}
