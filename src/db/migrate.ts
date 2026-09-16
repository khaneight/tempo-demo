import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Applies drizzle/ migrations. Runs at Vercel build time (vercel.json buildCommand)
 * and at Docker container start (docker-entrypoint.sh). Idempotent.
 *
 * Migrations need a direct connection: Neon's pooled URL (PgBouncer, transaction mode)
 * can't hold the migrator's advisory lock, so prefer DATABASE_URL_UNPOOLED when the
 * Neon integration provides it.
 */
async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (or DATABASE_URL_UNPOOLED) is not set");
  const pool = new Pool({ connectionString: url, max: 1 });
  await migrate(drizzle({ client: pool }), { migrationsFolder: "./drizzle" });
  await pool.end();
  console.log(`migrations applied (${process.env.DATABASE_URL_UNPOOLED ? "unpooled" : "pooled"} connection)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
