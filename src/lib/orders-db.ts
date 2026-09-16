import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db, type Tx } from "@/db";
import { offrampOrders, onrampOrders } from "@/db/schema";

export class OrderLockedError extends Error {
  constructor() {
    super("Order is being processed");
  }
}
export class NotFoundError extends Error {
  constructor(what = "Order") {
    super(`${what} not found`);
  }
}

type Table = typeof onrampOrders | typeof offrampOrders;
type Row<T extends Table> = T["$inferSelect"];

/**
 * `SELECT ... FOR UPDATE NOWAIT`: a concurrent processor gets an immediate
 * lock error (55P03) which we surface as OrderLockedError -> HTTP 409.
 */
export async function lockOrder<T extends Table>(tx: Tx, table: T, id: string): Promise<Row<T>> {
  try {
    const rows = (await tx
      .select()
      .from(table as PgTable)
      .where(eq(table.id, id))
      .for("update", { noWait: true })) as Row<T>[];
    if (!rows[0]) throw new NotFoundError();
    return rows[0];
  } catch (err) {
    if ((err as { code?: string; cause?: { code?: string } })?.code === "55P03") throw new OrderLockedError();
    if ((err as { cause?: { code?: string } })?.cause?.code === "55P03") throw new OrderLockedError();
    throw err;
  }
}

/**
 * Status-guarded update: only applies if the row is currently in one of
 * `from`. Returns the new row, or null if the guard failed (someone else
 * already moved it) — callers then re-read instead of overwriting.
 */
export async function transition<T extends Table>(
  exec: Tx | typeof db,
  table: T,
  id: string,
  from: readonly Row<T>["status"][],
  set: Partial<T["$inferInsert"]>,
): Promise<Row<T> | null> {
  const rows = (await exec
    .update(table as PgTable)
    .set({ ...set, updatedAt: sql`now()` } as never)
    .where(sql`${table.id} = ${id} and ${table.status} in ${from}`)
    .returning()) as Row<T>[];
  return rows[0] ?? null;
}

export async function getOrder<T extends Table>(table: T, id: string): Promise<Row<T> | null> {
  const rows = (await db
    .select()
    .from(table as PgTable)
    .where(eq(table.id, id))) as Row<T>[];
  return rows[0] ?? null;
}

export async function listByStatus<T extends Table>(table: T, statuses: readonly Row<T>["status"][], token: string): Promise<Row<T>[]> {
  return (await db
    .select()
    .from(table as PgTable)
    .where(and(inArray(table.status, statuses as never), eq(table.token, token)))) as Row<T>[];
}

export class WrongTokenError extends Error {
  constructor(orderToken: string, current: string) {
    super(`Order belongs to token ${orderToken || "(unknown)"}, not the active token ${current}`);
  }
}
/** Refuse to touch an order issued against another token (or one from before token scoping). */
export function assertCurrentToken(order: { token: string }, current: string) {
  if (order.token.toLowerCase() !== current.toLowerCase()) throw new WrongTokenError(order.token, current);
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}
