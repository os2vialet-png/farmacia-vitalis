export const instant = false;
import Link from "next/link";
import { db } from "@/src/lib/db";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import { accessibleBranchIds } from "@/src/lib/access";
import AppShell from "@/src/components/AppShell";
import NewTransferForm from "./NewTransferForm";


const STATUS_LABELS: Record<string, string> = {
  requested: "Solicitada",
  approved: "Aprobada",
  in_transit: "En tránsito",
  received: "Recibida",
  rejected: "Rechazada",
  cancelled: "Cancelada",
};

export default async function TransfersPage({
  searchParams,
}: {
  searchParams: Promise<{ branchId?: string; direction?: string }>;
}) {
  const session = await requirePagePermission("transfers.view");
  const params = await searchParams;

  const viewable = await accessibleBranchIds(session, "transfers.view");
  const requestable = await accessibleBranchIds(session, "transfers.request");

  const branchResult = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM farmacia.branches WHERE is_active = TRUE ORDER BY name`,
  );
  const branches = branchResult.rows.filter((branch) => viewable.includes(branch.id));

  const branchId = branches.some((branch) => branch.id === params.branchId)
    ? (params.branchId as string)
    : branches[0]?.id;

  const direction = params.direction === "outgoing" || params.direction === "incoming" ? params.direction : "all";

  const transfers = branchId
    ? (await db.query<{
        id: string;
        transfer_number: string;
        status: string;
        origin_name: string;
        destination_name: string;
        item_count: number;
        requested_label: string;
      }>(
        `SELECT t.id, t.transfer_number, t.status, ob.name AS origin_name, db.name AS destination_name,
                (SELECT COUNT(*)::int FROM farmacia.transfer_items ti WHERE ti.transfer_id = t.id) AS item_count,
                to_char(t.requested_at AT TIME ZONE 'America/Santo_Domingo', 'DD/MM/YYYY HH24:MI') AS requested_label
         FROM farmacia.transfers t
         INNER JOIN farmacia.branches ob ON ob.id = t.origin_branch_id
         INNER JOIN farmacia.branches db ON db.id = t.destination_branch_id
         WHERE (
           ($2 = 'outgoing' AND t.origin_branch_id = $1)
           OR ($2 = 'incoming' AND t.destination_branch_id = $1)
           OR ($2 = 'all' AND (t.origin_branch_id = $1 OR t.destination_branch_id = $1))
         )
         ORDER BY t.requested_at DESC
         LIMIT 200`,
        [branchId, direction],
      )).rows
    : [];

  const otherBranches = branches.filter((branch) => branch.id !== branchId);

  return (
    <AppShell session={session} activeItem="transfers">
      <main className="space-y-6 p-4 md:p-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Transferencias entre sucursales</h1>
            <p className="mt-1 text-sm text-gray-500">
              Solicitud → aprobación → despacho → recepción. El inventario se mueve solo en el despacho y en la recepción.
            </p>
          </div>
          <form method="get" className="flex flex-wrap items-end gap-2">
            <select name="branchId" defaultValue={branchId} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
            <select name="direction" defaultValue={direction} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
              <option value="all">Todas</option>
              <option value="incoming">Entrantes</option>
              <option value="outgoing">Salientes</option>
            </select>
            <button type="submit" className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50">Ver</button>
          </form>
        </div>

        {branchId && requestable.includes(branchId) && otherBranches.length > 0 && (
          <NewTransferForm
            destinationBranchId={branchId}
            originOptions={otherBranches.map((branch) => ({ id: branch.id, name: branch.name }))}
          />
        )}

        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-3">Número</th>
                <th className="px-3 py-3">Origen</th>
                <th className="px-3 py-3">Destino</th>
                <th className="px-3 py-3">Productos</th>
                <th className="px-3 py-3">Solicitud</th>
                <th className="px-3 py-3">Estado</th>
                <th className="px-3 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {transfers.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-8 text-center text-gray-500">No hay transferencias para esta selección.</td>
                </tr>
              )}
              {transfers.map((transfer) => (
                <tr key={transfer.id}>
                  <td className="px-3 py-3 font-semibold">{transfer.transfer_number}</td>
                  <td className="px-3 py-3">{transfer.origin_name}</td>
                  <td className="px-3 py-3">{transfer.destination_name}</td>
                  <td className="px-3 py-3">{transfer.item_count}</td>
                  <td className="px-3 py-3">{transfer.requested_label}</td>
                  <td className="px-3 py-3">{STATUS_LABELS[transfer.status] ?? transfer.status}</td>
                  <td className="px-3 py-3 text-right">
                    <Link href={`/transferencias/${transfer.id}`} className="text-green-700 hover:underline">Abrir</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>
    </AppShell>
  );
}
