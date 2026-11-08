
import "server-only";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("Falta configurar DATABASE_URL en .env.local");
}

export const db = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  application_name: "farmacia-vitalis",
});

db.on("error", (error) => {
  console.error("Error inesperado en el pool PostgreSQL:", error);
});
