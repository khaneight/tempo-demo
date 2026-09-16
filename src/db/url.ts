/**
 * Database connection strings. The Vercel Neon integration is configured with the
 * `TEMPO_` prefix, so it injects TEMPO_DATABASE_URL (pooled) and
 * TEMPO_DATABASE_URL_UNPOOLED (direct). Unprefixed names still work locally / in CI.
 */
const get = (name: string) => {
  const v = process.env[name]?.trim();
  return v ? v : undefined; // blank = unset (Vercel's UI saves empty values)
};

export function databaseUrl(): string | undefined {
  return get("TEMPO_DATABASE_URL") ?? get("DATABASE_URL");
}

/** Direct (non-PgBouncer) connection for the migrator; falls back to the pooled URL. */
export function migrationDatabaseUrl(): { url: string | undefined; unpooled: boolean } {
  const unpooled = get("TEMPO_DATABASE_URL_UNPOOLED") ?? get("DATABASE_URL_UNPOOLED");
  return unpooled ? { url: unpooled, unpooled: true } : { url: databaseUrl(), unpooled: false };
}
