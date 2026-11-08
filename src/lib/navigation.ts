// Navegación derivada de los permisos de la sesión. Es pura: no accede a la base de datos.
// La visibilidad de un enlace es solo una comodidad; cada página y API vuelve a validar el permiso.

export type NavSession = {
  roles: { code: string; permissions: string[] }[];
};

export type NavItem = {
  id: string;
  label: string;
  href: string;
};

type NavDefinition = NavItem & {
  /** Permiso que debe tener al menos un rol de la sesión. Vacío = siempre visible. */
  permission?: string;
  ownerOnly?: boolean;
};

const DEFINITIONS: NavDefinition[] = [
  { id: "dashboard", label: "Inicio", href: "/dashboard" },
  { id: "pos", label: "Punto de venta", href: "/pos", permission: "sales.create" },
  { id: "sales", label: "Historial de ventas", href: "/ventas", permission: "sales.view" },
  { id: "customers", label: "Clientes", href: "/clientes", permission: "customers.view" },
  { id: "purchases", label: "Compras", href: "/purchases", permission: "purchases.view" },
  { id: "suppliers", label: "Suplidores", href: "/suppliers", permission: "purchases.view" },
  { id: "inventory", label: "Inventario", href: "/inventory", permission: "inventory.view" },
  { id: "transfers", label: "Transferencias", href: "/transferencias", permission: "transfers.view" },
  { id: "catalog", label: "Catálogo", href: "/catalogo", permission: "catalog.view" },
  { id: "reports", label: "Reportes", href: "/reportes", permission: "reports.view" },
  { id: "audit", label: "Auditoría", href: "/auditoria", permission: "audit.view" },
  { id: "settings", label: "Configuración", href: "/configuracion", permission: "settings.manage" },
];

export function navigationFor(session: NavSession): NavItem[] {
  const hasPermission = (permission: string) =>
    session.roles.some((role) => role.permissions.includes(permission));
  const isOwner = session.roles.some((role) => role.code === "owner");

  return DEFINITIONS.filter((item) => {
    if (item.ownerOnly) return isOwner;
    if (!item.permission) return true;
    return hasPermission(item.permission);
  }).map(({ id, label, href }) => ({ id, label, href }));
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Propietario",
  admin: "Administrador",
  pharmacist: "Farmacéutico",
  inventory_manager: "Encargado de inventario",
  seller: "Vendedor",
};

export function roleLabelFor(session: NavSession): string {
  const labels = session.roles.map((role) => ROLE_LABELS[role.code] ?? role.code);
  return Array.from(new Set(labels)).join(" · ") || "Sin rol asignado";
}
