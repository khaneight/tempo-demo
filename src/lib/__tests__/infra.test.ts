import { beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { P256, PublicKey } from "ox";
import { Account } from "viem/tempo";
import { ZodError, z } from "zod";
import { db } from "@/db";
import { handle, readJson } from "@/lib/api";
import { AmountError } from "@/lib/amounts";
import { addressFromPublicKey, adminCookieValue, checkAdminPassword, verifyAdminCookie } from "@/lib/auth";
import { HttpError } from "@/lib/http-error";
import { pgKv } from "@/lib/kv-postgres";
import { NotFoundError, OrderLockedError } from "@/lib/orders-db";
import { resetDb } from "@/test/mock-chain";

describe("passkey address derivation", () => {
  it("matches viem's Tempo WebAuthn account address for the same public key", () => {
    for (let i = 0; i < 5; i++) {
      const pk = P256.randomPrivateKey();
      const pub = PublicKey.toHex(P256.getPublicKey({ privateKey: pk }));
      const viemAddr = Account.fromWebAuthnP256({ id: "cred", publicKey: pub }).address;
      expect(addressFromPublicKey(pub)).toBe(viemAddr.toLowerCase());
    }
  });
});

describe("admin cookie", () => {
  it("round-trips, rejects tampering, expiry and wrong password", () => {
    const v = adminCookieValue();
    expect(verifyAdminCookie(v)).toBe(true);
    const [scope, exp, sig] = v.split(".");
    expect(verifyAdminCookie(`${scope}.${Number(exp) + 1}.${sig}`)).toBe(false); // changed expiry breaks the MAC
    expect(verifyAdminCookie(`user.${exp}.${sig}`)).toBe(false);
    expect(verifyAdminCookie(`${scope}.${exp}.${sig.slice(0, -1)}x`)).toBe(false);
    expect(verifyAdminCookie(`admin.1.${sig}`)).toBe(false); // expired (and MAC mismatch)
    expect(verifyAdminCookie(undefined)).toBe(false);
    expect(verifyAdminCookie("garbage")).toBe(false);
    expect(checkAdminPassword(process.env.ADMIN_PASSWORD!)).toBe(true);
    expect(checkAdminPassword("nope")).toBe(false);
    expect(checkAdminPassword("")).toBe(false);
  });
});

describe("linked wallets cookie", () => {
  it("round-trips, is bound to the session, rejects tampering, expires per entry, and caps the list", async () => {
    const { decodeLinked, encodeLinked } = await import("@/lib/auth");
    const now = Date.now();
    const t = Math.floor(now / 1000);
    const w = [{ a: "0x59ef6877c5b6dd640ce9e1f94931e9eab40333ff" as const, c: "cred-1", t }];
    const v = encodeLinked(w, "sess-A", now);
    expect(decodeLinked(v, "sess-A", now)).toEqual(w);
    expect(decodeLinked(v, "sess-B", now)).toEqual([]); // another session's cookie is worthless
    expect(decodeLinked(v, null, now)).toEqual(w); // link route may carry entries over
    const [payload, sig] = v.split(".");
    expect(decodeLinked(`${payload}x.${sig}`, "sess-A", now)).toEqual([]);
    expect(decodeLinked(`${payload}.${sig.slice(1)}a`, "sess-A", now)).toEqual([]);
    expect(decodeLinked(v, "sess-A", now + 25 * 60 * 60 * 1000)).toEqual([]); // entry expired
    expect(decodeLinked(undefined, "sess-A", now)).toEqual([]);
    // Per-entry expiry: an old link is dropped while a fresh one survives re-encoding.
    const mixed = [{ a: w[0].a, c: "old", t: t - 25 * 60 * 60 }, { a: "0x1111111111111111111111111111111111111111" as const, c: "new", t }];
    expect(decodeLinked(encodeLinked(mixed, "s", now), "s", now).map((x) => x.c)).toEqual(["new"]);
    const many = Array.from({ length: 30 }, (_, i) => ({ a: `0x${i.toString(16).padStart(40, "0")}` as `0x${string}`, c: `c${i}`, t }));
    expect(decodeLinked(encodeLinked(many, "s", now), "s", now)).toHaveLength(20);
  });
});

describe("api handle()", () => {
  const ctx = { params: Promise.resolve({}) };
  const run = async (err: unknown) => {
    const res = await handle(async () => {
      throw err;
    })(new Request("http://x/"), ctx);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("maps domain errors to HTTP statuses without leaking internals", async () => {
    expect(await run(new HttpError(401, "Sign in first"))).toEqual({ status: 401, body: { error: "Sign in first" } });
    expect(await run(new OrderLockedError())).toMatchObject({ status: 409, body: { inProgress: true } });
    expect(await run(new NotFoundError())).toMatchObject({ status: 404 });
    expect(await run(new AmountError("Minimum is 1.00"))).toEqual({ status: 400, body: { error: "Minimum is 1.00" } });
    const zod = await run(new ZodError([{ code: "custom", path: ["card", "number"], message: "bad", input: "x" } as never]));
    expect(zod.status).toBe(400);
    expect(zod.body.error).toBe("card.number: bad");
    const internal = await run(new Error("SELECT * FROM secrets failed at pg.js:12"));
    expect(internal.status).toBe(500);
    expect(String(internal.body.error)).not.toContain("SELECT");
  });

  it("readJson rejects non-JSON bodies and validates with the schema", async () => {
    const schema = z.object({ amount: z.string() });
    await expect(readJson(new Request("http://x/", { method: "POST", body: "nope" }), schema)).rejects.toBeInstanceOf(HttpError);
    await expect(readJson(new Request("http://x/", { method: "POST", body: JSON.stringify({ amount: 5 }) }), schema)).rejects.toBeInstanceOf(ZodError);
    expect(await readJson(new Request("http://x/", { method: "POST", body: JSON.stringify({ amount: "5" }) }), schema)).toEqual({ amount: "5" });
  });
});

describe("Postgres-backed Kv for the passkey ceremony", () => {
  beforeEach(resetDb);

  it("set/get/delete with JSON values", async () => {
    await pgKv.set("a", { n: 1, s: "x" });
    expect(await pgKv.get("a")).toEqual({ n: 1, s: "x" });
    await pgKv.delete("a");
    expect(await pgKv.get("a")).toBeUndefined();
  });

  it("honours TTL on read (expired keys read as missing)", async () => {
    await pgKv.set("t", "v", { ttl: 3600 });
    expect(await pgKv.get("t")).toBe("v");
    await db.execute(sql`update kv set expires_at = now() - interval '1 second' where key = 't'`);
    expect(await pgKv.get("t")).toBeUndefined();
  });

  it("create is create-if-absent (duplicate credentials are rejected atomically) but reclaims expired keys", async () => {
    expect(await pgKv.create!("cred:1", { pk: "a" })).toBe(true);
    expect(await pgKv.create!("cred:1", { pk: "b" })).toBe(false);
    expect(await pgKv.get("cred:1")).toEqual({ pk: "a" });
    await db.execute(sql`update kv set expires_at = now() - interval '1 second' where key = 'cred:1'`);
    expect(await pgKv.create!("cred:1", { pk: "c" })).toBe(true);
    expect(await pgKv.get("cred:1")).toEqual({ pk: "c" });
  });

  it("take is one-shot: concurrent takers get exactly one value (WebAuthn challenges can't be replayed)", async () => {
    await pgKv.set("challenge:x", "c");
    const results = await Promise.all(Array.from({ length: 5 }, () => pgKv.take!("challenge:x")));
    expect(results.filter((r) => r === "c")).toHaveLength(1);
    expect(await pgKv.get("challenge:x")).toBeUndefined();
    await pgKv.set("challenge:y", "c", { ttl: 3600 });
    await db.execute(sql`update kv set expires_at = now() - interval '1 second' where key = 'challenge:y'`);
    expect(await pgKv.take!("challenge:y")).toBeUndefined();
  });
});
