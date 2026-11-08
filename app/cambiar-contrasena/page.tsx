export const instant = false;
import { redirect } from "next/navigation";
import { getSession } from "@/src/lib/auth/session";
import AppShell from "@/src/components/AppShell";
import ChangePasswordForm from "./ChangePasswordForm";

export default async function ChangePasswordPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  const forced = session.user.mustChangePassword;

  const form = (
    <main className="mx-auto max-w-lg p-6 md:p-10">
      <h2 className="text-2xl font-bold text-gray-900">Cambiar contraseña</h2>
      <p className="mb-6 mt-2 text-sm text-gray-500">
        Usa una contraseña que solo tú conozcas.
      </p>
      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <ChangePasswordForm forced={forced} />
      </div>
    </main>
  );

  // Con contraseña temporal no se muestra el menú: no debe haber enlaces a módulos bloqueados.
  if (forced) {
    return <div className="min-h-screen bg-[#f4f6f8]">{form}</div>;
  }

  return (
    <AppShell session={session} activeItem="password">
      {form}
    </AppShell>
  );
}
