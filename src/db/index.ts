import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { databaseUrl } from "./url";

/**
 * node-postgres (not the Neon HTTP driver) so we get real transactions with
 * `SELECT ... FOR UPDATE`. Works against local Docker Postgres and Neon's
 * pooled connection string from Vercel functions alike.
 */
const globalForDb = globalThis as unknown as { __pool?: Pool };

function pool() {
  if (!globalForDb.__pool) {
    // TLS is driven by the connection string (`sslmode=verify-full` on Neon); the server
    // certificate is verified — never set rejectUnauthorized:false for a ledger.
    globalForDb.__pool = new Pool({ connectionString: databaseUrl(), max: 5 });
  }
  return globalForDb.__pool;
}

export const db = drizzle({ client: pool(), schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export { schema };
