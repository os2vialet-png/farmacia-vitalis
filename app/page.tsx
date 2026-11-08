import { redirect } from "next/navigation";

// La raíz no tiene contenido propio: el panel valida la sesión y redirige a /login si hace falta.
export default function Home() {
  redirect("/dashboard");
}
