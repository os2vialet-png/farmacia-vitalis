export const instant = false;
import { db } from "@/src/lib/db";
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import { accessibleBranchIds } from "@/src/lib/access";
import { hasPermission } from "@/src/lib/auth/permissions";
import AppShell from "@/src/components/AppShell";
import PosTerminal from "./PosTerminal";


export default async function PosPage() {
  const session = await requirePagePermission("sales.create");

  const allowedIds = new Set(await accessibleBranchIds(session, "sales.create"));

  const branchResult = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM farmacia.branches WHERE is_active = TRUE ORDER BY name`,
  );

  const branches = branchResult.rows.filter((branch) => allowedIds.has(branch.id));

  const canDiscountAnywhere = branches.some((branch) =>
    hasPermission(session, "sales.discount", branch.id),
  );

  return (
    <AppShell session={session} activeItem="pos">
      <PosTerminal
        branches={branches}
        canDiscount={canDiscountAnywhere}
        discountBranchIds={branches
          .filter((branch) => hasPermission(session, "sales.discount", branch.id))
          .map((branch) => branch.id)}
      />
    </AppShell>
  );
}
