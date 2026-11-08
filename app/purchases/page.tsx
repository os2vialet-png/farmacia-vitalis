export const instant = false;
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import AppShell from "@/src/components/AppShell";
import PurchasesManager from "./purchases-manager";


export default async function PurchasesPage() {
  const session = await requirePagePermission("purchases.view");

  return (
    <AppShell session={session} activeItem="purchases">
      <PurchasesManager />
    </AppShell>
  );
}
