import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle({ client: pool });
  await migrate(db, { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log("migrations applied");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
