/** Logo de la cruz de farmacia (usable desde componentes de servidor y de cliente). */
export function PharmacyCross({ className = "h-10 w-10" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true">
      <rect x="2" y="2" width="44" height="44" rx="12" fill="var(--vitalis-green)" />
      <path d="M20 10h8v10h10v8H28v10h-8V28H10v-8h10V10Z" fill="var(--vitalis-white)" />
      <circle cx="36" cy="36" r="7" fill="var(--vitalis-red)" />
      <path d="M36 32.5v7M32.5 36h7" stroke="var(--vitalis-white)" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
