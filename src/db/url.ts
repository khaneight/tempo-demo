/**
 * Database connection strings. The Vercel Neon integration is configured with the
 * `TEMPO_` prefix, so it injects TEMPO_DATABASE_URL (pooled) and
 * TEMPO_DATABASE_URL_UNPOOLED (direct). Unprefixed names still work locally / in CI.
 */
export function databaseUrl(): string | undefined {
  return process.env.TEMPO_DATABASE_URL ?? process.env.DATABASE_URL;
}

/** Direct (non-PgBouncer) connection for the migrator; falls back to the pooled URL. */
export function migrationDatabaseUrl(): { url: string | undefined; unpooled: boolean } {
  const unpooled = process.env.TEMPO_DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL_UNPOOLED;
  return unpooled ? { url: unpooled, unpooled: true } : { url: databaseUrl(), unpooled: false };
}
