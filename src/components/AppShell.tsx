import Link from "next/link";
import type { ReactNode } from "react";
import LogoutButton from "./LogoutButton";
import FloatingAssistant from "./FloatingAssistant";
import { cloudAiEnabled } from "@/src/lib/ai-client";
import { PharmacyCross } from "./PharmacyCross";
import { navigationFor, roleLabelFor, type NavSession, type NavItem } from "@/src/lib/navigation";

type Props = {
  children: ReactNode;
  session: NavSession & { user: { firstName: string; lastName: string } };
  activeItem: string;
};

const MODULE_ICONS: Record<string, ReactNode> = {
  dashboard: <path d="M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1v-8.5Z" />,
  pos: <path d="M3 5h18l-2 7H5L3 5Zm2 9h14l-1 5H6l-1-5Zm5-2h6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  "owner-assistant": <path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3Zm6 11 .9 2.1L21 17l-2.1.9L18 20l-.9-2.1L15 17l2.1-.9L18 14Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
  sales: <path d="M4 19h16M5 16c2-1 4-5 7-8s5-2 7-4M6 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  customers: <path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Zm-8 8a8 8 0 0 1 16 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  purchases: <path d="M5 8h14l-1 11H6L5 8Zm4 0a3 3 0 0 1 6 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  suppliers: <path d="M3 7h11v10H3V7Zm11 3h4l3 3v4h-7v-7Zm-5.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
  inventory: <path d="M4 7l8-4 8 4v10l-8 4-8-4V7Zm8 4v9m8-13-8 4-8-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />,
  transfers: <path d="M5 9h11l-3-3m2 3-2 2M19 15H8l3 3m-2-3 2-2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  catalog: <path d="M5 4h14v16H5V4Zm3 4h8M8 12h8m-8 4h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  reports: <path d="M4 20h16M7 16v-5m5 5V7m5 9v-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  users: <path d="M12 11a3.5 3.5 0 1 0-3.5-3.5A3.5 3.5 0 0 0 12 11Zm-7 9a7 7 0 0 1 14 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />,
  audit: <path d="M6 3h9l4 4v14H6V3Zm9 1v4h4M9 13h7m-7 4h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  settings: <path d="M12 15a3 3 0 1 0-3-3 3 3 0 0 0 3 3Zm8-3a8 8 0 0 0-.2-1.7l2-1.5-2-3.4-2.3 1a8 8 0 0 0-2.9-1.7L14.2 2H9.8L9.4 4.7a8 8 0 0 0-2.9 1.7l-2.3-1-2 3.4 2 1.5A8 8 0 0 0 4 12a8 8 0 0 0 .2 1.7l-2 1.5 2 3.4 2.3-1a8 8 0 0 0 2.9 1.7l.4 2.7h4.4l.4-2.7a8 8 0 0 0 2.9-1.7l2.3 1 2-3.4-2-1.5A8 8 0 0 0 20 12Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />,
};

function ModuleIcon({ id }: { id: string }) {
  const glyph = MODULE_ICONS[id];
  return (
    <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 shrink-0" width="18" height="18" aria-hidden="true">
      {glyph ?? <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" />}
    </svg>
  );
}

export { PharmacyCross };

export default function AppShell({ children, session, activeItem }: Props) {
  const navigation = navigationFor(session);
  const currentUser = `${session.user.firstName} ${session.user.lastName}`;
  // Botón flotante del asistente: propietario y administradores, excepto en su propia pantalla.
  const showAssistant =
    activeItem !== "owner-assistant" && session.roles.some((role) => role.permissions.includes("users.view"));

  return (
    <div className="min-h-screen bg-[var(--vitalis-bg)] text-[var(--vitalis-ink)] md:flex">
      <aside className="flex w-full shrink-0 flex-col border-r border-[var(--vitalis-line)] bg-white md:min-h-screen md:w-64">
        <div className="vitalis-strip" aria-hidden="true"></div>
        <div className="border-b border-[var(--vitalis-line)] p-5">
          <div className="flex items-center gap-3">
            <PharmacyCross />
            <div>
              <h1 className="text-lg font-bold tracking-tight text-[var(--vitalis-green-dark)]">VITALIS</h1>
              <p className="text-xs font-medium text-[var(--vitalis-red)]">Farmacia Inteligente</p>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 p-4" aria-label="Módulos">
          {navigation.map((item: NavItem) => {
            const active = activeItem === item.id;
            return (
              <Link
                key={item.id}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`block rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                  active
                    ? "bg-[var(--vitalis-green-soft)] text-[var(--vitalis-green-dark)] shadow-[inset_3px_0_0_var(--vitalis-green)]"
                    : "text-[var(--vitalis-muted)] hover:bg-emerald-50/60 hover:text-[var(--vitalis-green-dark)]"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <ModuleIcon id={item.id} />
                  {item.label}
                </span>
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-[var(--vitalis-line)] p-4">
          <p className="truncate px-3 text-sm font-semibold">{currentUser}</p>
          <p className="px-3 pb-2 text-xs font-medium text-[var(--vitalis-green-dark)]">{roleLabelFor(session)}</p>
          <Link href="/cambiar-contrasena" className="block px-3 pb-3 text-xs text-[var(--vitalis-muted)] hover:text-[var(--vitalis-ink)]">
            Cambiar contraseña
          </Link>
          <LogoutButton />
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="flex min-h-16 items-center justify-between border-b border-[var(--vitalis-line)] bg-white px-6">
          <p className="text-sm font-medium text-[var(--vitalis-muted)]">
            <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full bg-[var(--vitalis-red)] align-middle" aria-hidden="true"></span>
            Sistema de gestión farmacéutica
          </p>
          <span className="rounded-full bg-[var(--vitalis-green-soft)] px-3 py-1 text-xs font-semibold text-[var(--vitalis-green-dark)]">Farmacia Vitalis</span>
        </header>
        {children}
      </div>
      {showAssistant && <FloatingAssistant firstName={session.user.firstName} voiceEnabled={cloudAiEnabled()} />}
    </div>
  );
}
