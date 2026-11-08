/**
 * Etiquetas de transferencias compartidas por servidor y cliente.
 * Sin "server-only": la interfaz necesita estas listas para la conciliación.
 */

export const MISSING_RESOLUTIONS = ["returned", "found_late", "written_off"] as const;

export type MissingResolution = (typeof MISSING_RESOLUTIONS)[number];

export const RESOLUTION_LABELS: Record<MissingResolution, string> = {
  returned: "Devueltas a origen",
  found_late: "Llegaron tarde",
  written_off: "Dadas por perdidas",
};
