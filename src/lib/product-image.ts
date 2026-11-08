/**
 * Clasificación de un producto según su forma farmacéutica para mostrar el ícono
 * correspondiente. No inventa datos: solo clasifica lo que ya registra la base.
 */

export type ProductIconCategory =
  | "tableta"
  | "capsula"
  | "liquido"
  | "inyectable"
  | "topico"
  | "gotas"
  | "supositorio"
  | "inhalador"
  | "polvo"
  | "otro";

export function productIconCategory(dosageForm: string | null | undefined): ProductIconCategory {
  const form = (dosageForm ?? "").toLowerCase();
  if (/tableta|comprimido|capleta|gragea|pastilla|tablet/.test(form)) return "tableta";
  if (/cápsula|capsula/.test(form)) return "capsula";
  if (/jarabe|solución\s+oral|solucion\s+oral|suspensión|suspension|elixir|elixir|líquido|liquido|sirope|solución\s+pediatrica/.test(form)) return "liquido";
  if (/inyectable|ampolla|ampoule|vial|parenteral|subcutánea|subcutanea|intramuscular|intravenosa|polvo\s+.*inyect/.test(form)) return "inyectable";
  if (/crema|pomada|ungüento|unguento|gel|óvulo|ovulo|loción|locion|solución\s+tópica|solucion\s+topica|spray\s+tópico/.test(form)) return "topico";
  if (/gotas|colirio|oftálmica|oftalmica|nasal|ótica|otica/.test(form)) return "gotas";
  if (/supositorio/.test(form)) return "supositorio";
  if (/inhalador|aerosol|spray|nebulización|nebulizacion/.test(form)) return "inhalador";
  if (/polvo|granulado|sobres|sachet|sobre\s|efervescente/.test(form)) return "polvo";
  return "otro";
}

export function productIconLabel(category: ProductIconCategory): string {
  switch (category) {
    case "tableta": return "tabletas o comprimidos";
    case "capsula": return "cápsulas";
    case "liquido": return "líquido oral";
    case "inyectable": return "inyectable";
    case "topico": return "uso tópico";
    case "gotas": return "gotas";
    case "supositorio": return "supositorios";
    case "inhalador": return "aerosol o inhalador";
    case "polvo": return "polvo o sobres";
    default: return "producto farmacéutico";
  }
}
