import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { TEST_DATABASE_URL } from "./db-url";

/** Migrate the dedicated test database once per vitest run. */
export default async function setup() {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
  await pool.end();
}
