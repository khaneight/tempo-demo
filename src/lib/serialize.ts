/** JSON-safe view of a DB row: bigint -> string, Date -> ISO. */
export type Serialized<T> = {
  [K in keyof T]: T[K] extends bigint
    ? string
    : T[K] extends bigint | null
      ? string | null
      : T[K] extends Date
        ? string
        : T[K] extends Date | null
          ? string | null
          : T[K];
};

export function serialize<T extends object>(row: T): Serialized<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "bigint" ? v.toString() : v instanceof Date ? v.toISOString() : v;
  }
  return out as Serialized<T>;
}

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(
    JSON.parse(JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v))),
    init,
  );
}
