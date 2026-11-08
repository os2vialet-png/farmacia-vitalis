export const instant = false;
import { db } from "@/src/lib/db";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import { accessibleBranchIds } from "@/src/lib/access";
import AppShell from "@/src/components/AppShell";
import InventoryManager from "./InventoryManager";


export default async function InventoryPage() {
  const session = await requirePagePermission("inventory.view");

  const allowedIds = new Set(await accessibleBranchIds(session, "inventory.view"));

  const branchResult = await db.query<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM farmacia.branches WHERE is_active = TRUE ORDER BY name`,
  );

  const branches = branchResult.rows.filter((branch) => allowedIds.has(branch.id));

  return (
    <AppShell session={session} activeItem="inventory">
      <InventoryManager branches={branches} />
    </AppShell>
  );
}
