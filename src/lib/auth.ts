import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Handler } from "accounts/server";
import { Address, PublicKey } from "ox";
import { cookies } from "next/headers";
import { db } from "@/db";
import { users } from "@/db/schema";
import { env } from "./env";
import { HttpError } from "./http-error";
import { pgKv } from "./kv-postgres";

/**
 * Tempo derives a P256/WebAuthn account's address exactly like Ethereum does
 * for secp256k1: last 20 bytes of keccak256(pubX || pubY). ox implements that.
 */
export function addressFromPublicKey(publicKeyHex: string): `0x${string}` {
  return Address.fromPublicKey(PublicKey.fromHex(publicKeyHex as `0x${string}`)).toLowerCase() as `0x${string}`;
}

async function upsertUser(p: { credentialId: string; publicKey: string }) {
  const address = addressFromPublicKey(p.publicKey);
  await db
    .insert(users)
    .values({ address, credentialId: p.credentialId })
    .onConflictDoNothing({ target: users.address });
  return address;
}

let handler: ReturnType<typeof Handler.webAuthn> | undefined;
/**
 * Server-side passkey ceremony. Stores credential public keys + sessions in
 * Postgres (via pgKv), so a user can sign in from any device and always
 * derive the same wallet address. Mounted at /api/auth/*.
 */
export function webAuthnHandler() {
  if (!handler) {
    const e = env();
    handler = Handler.webAuthn({
      kv: pgKv,
      origin: e.ORIGIN,
      rpId: e.RP_ID,
      path: "/api/auth",
      cors: false, // same-origin only; the ceremony endpoints have no business being called cross-site
      onRegister: async ({ credentialId, publicKey }) => {
        await upsertUser({ credentialId, publicKey });
      },
      onAuthenticate: async ({ credentialId, publicKey }) => {
        await upsertUser({ credentialId, publicKey });
      },
    });
  }
  return handler;
}

export type SessionUser = { address: `0x${string}`; credentialId: string };

/** Resolves the passkey session from the request cookie; null if signed out. */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const session = await webAuthnHandler().getSession(req);
  if (!session) return null;
  return { address: addressFromPublicKey(session.publicKey), credentialId: session.credentialId };
}

export async function requireUser(req: Request): Promise<SessionUser> {
  const u = await getSessionUser(req);
  if (!u) throw new HttpError(401, "Sign in with your passkey first");
  return u;
}

// ---- Admin: shared password -> HMAC-signed cookie -------------------------

const ADMIN_COOKIE = "acme_admin";
const ADMIN_TTL_S = 12 * 60 * 60;

/** Key = HMAC(AUTH_SECRET, ADMIN_PASSWORD): rotating either secret invalidates every issued cookie. */
function sign(payload: string) {
  const e = env();
  const key = createHmac("sha256", e.AUTH_SECRET).update(e.ADMIN_PASSWORD).digest();
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function adminCookieValue(): string {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_TTL_S;
  const payload = `admin.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyAdminCookie(value: string | undefined): boolean {
  if (!value) return false;
  const [scope, exp, sig] = value.split(".");
  if (scope !== "admin" || !exp || !sig) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  const expected = sign(`${scope}.${exp}`);
  return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export function checkAdminPassword(password: string): boolean {
  // Hash both sides so the comparison is constant-time regardless of length.
  const h = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(env().ADMIN_PASSWORD), h(password));
}

export async function isAdmin(): Promise<boolean> {
  const jar = await cookies();
  return verifyAdminCookie(jar.get(ADMIN_COOKIE)?.value);
}

export function isAdminRequest(req: Request): boolean {
  const raw = req.headers.get("cookie") ?? "";
  const m = raw.match(new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]+)`));
  return verifyAdminCookie(m?.[1]);
}

export { ADMIN_COOKIE, ADMIN_TTL_S };
