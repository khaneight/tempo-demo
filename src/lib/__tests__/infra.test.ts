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
import { makeUser, resetDb } from "@/test/mock-chain";

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

describe("identities", () => {
  beforeEach(resetDb);

  it("validates usernames and enforces uniqueness at registration", async () => {
    const { canActFor, createIdentityWithWallet, normalizeUsername, usernameAvailable, UsernameError } = await import("@/lib/identity");
    expect(normalizeUsername("  Ada_Lovelace ")).toBe("ada_lovelace");
    for (const bad of ["ab", "-ada", "ada lovelace", "a".repeat(25), "ada!"]) expect(() => normalizeUsername(bad), bad).toThrow(UsernameError);
    expect(await usernameAvailable("ada")).toEqual({ ok: true });
    const id = await createIdentityWithWallet({ username: "Ada", address: "0x1111111111111111111111111111111111111111", credentialId: "c1" });
    expect(id.username).toBe("ada");
    expect((await usernameAvailable("ADA")).ok).toBe(false);
    await expect(createIdentityWithWallet({ username: "ada", address: "0x2222222222222222222222222222222222222222", credentialId: "c2" })).rejects.toBeInstanceOf(UsernameError);
    // a session may act for sibling wallets only
    const wallets = [{ address: "0x1111111111111111111111111111111111111111" }, { address: "0x3333333333333333333333333333333333333333" }];
    expect(canActFor(wallets[0].address, wallets[1].address, wallets)).toBe(true);
    expect(canActFor(wallets[0].address, "0x9999999999999999999999999999999999999999", wallets)).toBe(false);
    expect(canActFor("0x9999999999999999999999999999999999999999", wallets[1].address, wallets)).toBe(false);
  });

  it("adds wallets under an identity with labels, renames only its own, and gives legacy wallets an identity", async () => {
    const { addWalletToIdentity, createIdentityWithWallet, ensureIdentity, identityOfWallet, renameWalletLabel, walletsOf } = await import("@/lib/identity");
    const a = "0x1111111111111111111111111111111111111111" as const;
    const b = "0x2222222222222222222222222222222222222222" as const;
    const id = await createIdentityWithWallet({ username: "ada", address: a, credentialId: "c1" });
    await addWalletToIdentity({ identityId: id.id, address: b, credentialId: "c2", label: "" });
    expect((await walletsOf(id.id)).map((w) => [w.address, w.label])).toEqual([[a, "Main"], [b, "Wallet 2"]]);
    expect((await renameWalletLabel(id.id, b, "  Savings  "))?.label).toBe("Savings");
    const other = await createIdentityWithWallet({ username: "bob", address: "0x3333333333333333333333333333333333333333", credentialId: "c3" });
    expect(await renameWalletLabel(other.id, b, "hijack")).toBeNull();
    expect((await identityOfWallet(b))?.username).toBe("ada");
    // legacy wallet (row without identity) is adopted on sign-in with a derived username
    const legacy = await makeUser("cc");
    const created = await ensureIdentity(legacy, `cred-${legacy}`);
    expect(created.username).toMatch(/^user-[0-9a-f]{6}$/);
    expect((await identityOfWallet(legacy))?.wallet.label).toBe("Main");
    expect((await ensureIdentity(legacy, "x")).id).toBe(created.id); // idempotent
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
