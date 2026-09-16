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

// ---- Linked wallets: sign in once per wallet, then switch freely ----------
//
// The accounts session cookie identifies ONE credential (the last one that went
// through a passkey ceremony). A person with several wallets shouldn't have to
// re-prove each one on every switch, so every wallet that completes a ceremony in
// this browser is recorded in a signed `acme_wallets` cookie. API calls name the
// wallet they act for (`x-wallet` header); it's honoured only if it is the
// session's own credential or one already linked here. Signing transactions
// still prompts the passkey — that's the wallet's key, not the session.

const LINKED_COOKIE = "acme_wallets";
const LINKED_TTL_S = 24 * 60 * 60;
/** a = address, c = credential id, t = linked-at (unix s). Each entry expires on its own; linking never extends others. */
type Linked = { a: `0x${string}`; c: string; t: number };

function linkedKey() {
  return createHmac("sha256", env().AUTH_SECRET).update("linked-wallets").digest();
}
/** The cookie is bound to the passkey session it was issued under (hash of the session token). */
function sessionHash(req: Request): string | null {
  const tok = cookieValue(req, "accounts_webauthn");
  return tok ? createHash("sha256").update(tok).digest("base64url") : null;
}
export function encodeLinked(wallets: Linked[], session: string, now = Date.now()): string {
  const fresh = wallets.filter((w) => w.t + LINKED_TTL_S > now / 1000).slice(-20);
  const payload = Buffer.from(JSON.stringify({ w: fresh, s: session })).toString("base64url");
  const sig = createHmac("sha256", linkedKey()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
export function decodeLinked(value: string | undefined, session: string | null, now = Date.now()): Linked[] {
  if (!value) return [];
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return [];
  const expected = createHmac("sha256", linkedKey()).update(payload).digest("base64url");
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return [];
  try {
    const { w, s } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { w: Linked[]; s: string };
    // `session === null` means "don't check the binding" (only the link route uses it, to carry entries over).
    if (session !== null && s !== session) return [];
    return w.filter((x) => /^0x[0-9a-f]{40}$/.test(x.a) && typeof x.c === "string" && typeof x.t === "number" && x.t + LINKED_TTL_S > now / 1000);
  } catch {
    return [];
  }
}
function cookieValue(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie") ?? "";
  return raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
}
/** Wallets linked under the CURRENT passkey session (empty if signed out or the cookie belongs to another session). */
export function linkedWallets(req: Request): Linked[] {
  const s = sessionHash(req);
  return s ? decodeLinked(cookieValue(req, LINKED_COOKIE), s) : [];
}
/** Entries carried over when re-linking under a new session (signature still ours; binding re-issued). */
export function linkedWalletsAnySession(req: Request): Linked[] {
  return decodeLinked(cookieValue(req, LINKED_COOKIE), null);
}
export function linkedCookieHeader(req: Request, wallets: Linked[]): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  const s = sessionHash(req) ?? "";
  return `${LINKED_COOKIE}=${encodeLinked(wallets, s)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${LINKED_TTL_S}${secure}`;
}
export function clearLinkedCookieHeader(): string {
  return `${LINKED_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/**
 * Resolves who the request acts for. Requires a live passkey session; the
 * `x-wallet` header may then select any wallet linked under THIS session.
 * Signed out (or a cookie from another session) => null.
 */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const session = await webAuthnHandler().getSession(req);
  if (!session) return null;
  const own: SessionUser = { address: addressFromPublicKey(session.publicKey), credentialId: session.credentialId };
  const requested = req.headers.get("x-wallet")?.trim().toLowerCase();
  if (!requested) return own;
  if (!/^0x[0-9a-f]{40}$/.test(requested)) return null;
  if (own.address === requested) return own;
  const linked = linkedWallets(req).find((w) => w.a === requested);
  return linked ? { address: linked.a, credentialId: linked.c } : null;
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
