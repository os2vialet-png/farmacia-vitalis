export const instant = false;
import { requirePagePermission } from "@/src/lib/auth/page-guard";
import AppShell from "@/src/components/AppShell";
import SuppliersManager from "./suppliers-manager";


export default async function SuppliersPage() {
  const session = await requirePagePermission("purchases.view");

  return (
    <AppShell session={session} activeItem="suppliers">
      <SuppliersManager />
    </AppShell>
  );
}
