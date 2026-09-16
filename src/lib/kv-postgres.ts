import { sql } from "drizzle-orm";
import { Kv } from "accounts/server";
import { db } from "@/db";

/**
 * `accounts/server` Kv backed by the `kv` Postgres table.
 *
 * Both optional atomic ops are implemented because Postgres gives us
 * linearizable primitives for free:
 *  - `create` = INSERT ... ON CONFLICT DO NOTHING (rejects duplicate credentials)
 *  - `take`   = DELETE ... RETURNING          (one-time-use challenges)
 * Expiry is lazy: expired rows are ignored on read and overwritten on write.
 */
export const pgKv = Kv.from({
  async get<value = unknown>(key: string) {
    const res = await db.execute<{ value: value }>(
      sql`select value from kv where key = ${key} and (expires_at is null or expires_at > now())`,
    );
    return res.rows[0]?.value;
  },

  async set(key: string, value: unknown, options?: { ttl?: number | undefined }) {
    const json = JSON.stringify(value ?? null);
    const ttl = options?.ttl;
    await db.execute(sql`
      insert into kv (key, value, expires_at)
      values (${key}, ${json}::jsonb, ${ttl ? sql`now() + (${ttl} * interval '1 second')` : sql`null`})
      on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
    `);
  },

  async delete(key: string) {
    await db.execute(sql`delete from kv where key = ${key}`);
  },

  async create(key: string, value: unknown, options?: { ttl?: number | undefined }) {
    const json = JSON.stringify(value ?? null);
    const ttl = options?.ttl;
    // Clear an expired tombstone first so the insert can win.
    await db.execute(sql`delete from kv where key = ${key} and expires_at is not null and expires_at <= now()`);
    const res = await db.execute(sql`
      insert into kv (key, value, expires_at)
      values (${key}, ${json}::jsonb, ${ttl ? sql`now() + (${ttl} * interval '1 second')` : sql`null`})
      on conflict (key) do nothing
    `);
    return (res.rowCount ?? 0) > 0;
  },

  async take<value = unknown>(key: string) {
    const res = await db.execute<{ value: value; expired: boolean }>(sql`
      delete from kv where key = ${key}
      returning value, (expires_at is not null and expires_at <= now()) as expired
    `);
    const row = res.rows[0];
    if (!row || row.expired) return undefined;
    return row.value;
  },
});
