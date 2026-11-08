import type { ReactNode } from "react";
import { productIconCategory, productIconLabel } from "@/src/lib/product-image";

type Props = {
  name: string;
  dosageForm?: string | null;
  imageUrl?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
};

const SIZE_CLASS: Record<NonNullable<Props["size"]>, string> = {
  sm: "h-10 w-10",
  md: "h-16 w-16",
  lg: "h-24 w-24",
};

const TINTS: Record<string, { bg: string; ink: string }> = {
  tableta: { bg: "#e9f8f0", ink: "#00843d" },
  capsula: { bg: "#eef4ff", ink: "#2563c9" },
  liquido: { bg: "#fff4e6", ink: "#b25f0a" },
  inyectable: { bg: "#fdecee", ink: "#c22833" },
  topico: { bg: "#f3edff", ink: "#6b4bd6" },
  gotas: { bg: "#e6f6f8", ink: "#0f7d8c" },
  supositorio: { bg: "#fdf1e3", ink: "#a9571d" },
  inhalador: { bg: "#eef6e8", ink: "#4a7c10" },
  polvo: { bg: "#f2f4f6", ink: "#52606b" },
  otro: { bg: "#eaf5ef", ink: "#0c6e46" },
};

function Glyph({ category }: { category: ReturnType<typeof productIconCategory> }): ReactNode {
  switch (category) {
    case "tableta":
      return (
        <>
          <ellipse cx="17" cy="23" rx="9" ry="6" transform="rotate(-30 17 23)" fill="currentColor" />
          <path d="M22 19c-2.2 2.6-6 6.2-9 8.2" stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" opacity="0.55" />
          <rect x="27" y="27" width="12" height="7.5" rx="3.75" transform="rotate(25 27 27)" fill="currentColor" opacity="0.65" />
        </>
      );
    case "capsula":
      return (
        <>
          <rect x="13" y="10" width="15" height="26" rx="7.5" transform="rotate(35 13 10)" fill="currentColor" opacity="0.8" />
          <rect x="21" y="15" width="15" height="26" rx="7.5" transform="rotate(35 21 15)" fill="#ffffff" opacity="0.25" />
        </>
      );
    case "liquido":
      return (
        <>
          <rect x="15" y="9" width="8" height="5" rx="1.5" fill="currentColor" opacity="0.75" />
          <path d="M14 15h10l2 4v10a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3V19l2-4Z" fill="currentColor" opacity="0.35" />
          <path d="M12 25c2-1.6 4.6-1.6 7 0s5 1.6 7 0v5a3 3 0 0 1-3 3H15a3 3 0 0 1-3-3v-5Z" fill="currentColor" />
        </>
      );
    case "inyectable":
      return (
        <>
          <rect x="19" y="6" width="6" height="24" rx="2.5" transform="rotate(40 19 6)" fill="currentColor" opacity="0.85" />
          <path d="m13 31-3.5 3.5M11 34l-2.6 2.6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </>
      );
    case "topico":
      return (
        <>
          <rect x="14" y="20" width="16" height="14" rx="3" fill="currentColor" opacity="0.85" />
          <rect x="18" y="12" width="8" height="6" rx="1.5" fill="currentColor" />
          <path d="M20 24h4" stroke="#ffffff" strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />
        </>
      );
    case "gotas":
      return (
        <>
          <path d="M17 8h4M19 8v5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M15 13h8l1.6 3v11a2.6 2.6 0 0 1-2.6 2.6h-6A2.6 2.6 0 0 1 13.4 27V16l1.6-3Z" fill="currentColor" opacity="0.4" />
          <path d="M19 22a4.5 4.5 0 1 0 4.5-4.5" fill="currentColor" />
        </>
      );
    case "supositorio":
      return (
        <>
          <path d="M28 30a9 9 0 0 1-14.5-7.2 9 9 0 0 1 7.9-14.4L28 10l-6.5 6.5L28 30Z" fill="currentColor" opacity="0.85" transform="rotate(-18 20 20)" />
        </>
      );
    case "inhalador":
      return (
        <>
          <rect x="12" y="16" width="16" height="18" rx="4" fill="currentColor" opacity="0.8" />
          <rect x="21" y="10" width="7" height="7" rx="2" fill="currentColor" />
          <circle cx="20" cy="25" r="3.2" fill="#ffffff" opacity="0.5" />
        </>
      );
    case "polvo":
      return (
        <>
          <path d="M11 13h18l2 12a4 4 0 0 1-4 4H13a4 4 0 0 1-4-4l2-12Z" fill="currentColor" opacity="0.75" />
          <path d="M11 13 15 7h10l4 6" fill="currentColor" opacity="0.5" />
        </>
      );
    default:
      return (
        <>
          <path d="M20 8h8v12h12v8H28v12h-8V28H8v-8h12V8Z" fill="currentColor" opacity="0.8" />
        </>
      );
  }
}

/**
 * Foto del producto cuando existe, o un ícono elegante según la forma farmacéutica.
 * Los íconos son presentación de la interfaz: no son datos del producto.
 */
export default function ProductImage({ name, dosageForm, imageUrl, size = "md", className = "" }: Props) {
  const category = productIconCategory(dosageForm);
  const tint = TINTS[category];
  const label = `${name} (${productIconLabel(category)})`;

  if (imageUrl) {
    return (
      <span
        className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-xl border border-[var(--vitalis-line)] bg-white ${SIZE_CLASS[size]} ${className}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt={name} loading="lazy" className="h-full w-full object-contain" />
      </span>
    );
  }

  return (
    <span
      role="img"
      aria-label={label}
      className={`inline-flex shrink-0 items-center justify-center rounded-xl ${SIZE_CLASS[size]} ${className}`}
      style={{ backgroundColor: tint.bg, color: tint.ink }}
    >
      <svg viewBox="0 0 40 40" className="h-3/4 w-3/4" fill="none" aria-hidden="true">
        <Glyph category={category} />
      </svg>
    </span>
  );
}
