
import "server-only";
import { db } from "./db";

async function testConnection() {
  try {
    const result = await db.query(`
      SELECT
        current_database() AS database,
        current_user AS username,
        current_schema() AS schema,
        NOW() AS server_time
    `);

    console.log("CONEXIÓN EXITOSA");
    console.log(result.rows[0]);
  } catch (error) {
    console.error("ERROR DE CONEXIÓN:", error);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}

testConnection();
