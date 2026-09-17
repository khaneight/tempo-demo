import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Handler } from "accounts/server";
import { Address, PublicKey } from "ox";
import { cookies } from "next/headers";
import { env } from "./env";
import { HttpError } from "./http-error";
import { addWalletToIdentity, canActFor, createIdentityWithWallet, ensureIdentity, identityOfWallet, pendingLabelKey, walletsOf } from "./identity";
import { pgKv } from "./kv-postgres";

/**
 * Tempo derives a P256/WebAuthn account's address exactly like Ethereum does
 * for secp256k1: last 20 bytes of keccak256(pubX || pubY). ox implements that.
 */
export function addressFromPublicKey(publicKeyHex: string): `0x${string}` {
  return Address.fromPublicKey(PublicKey.fromHex(publicKeyHex as `0x${string}`)).toLowerCase() as `0x${string}`;
}

let handler: ReturnType<typeof Handler.webAuthn> | undefined;
/**
 * Server-side passkey ceremony. Stores credential public keys + sessions in
 * Postgres (via pgKv), so a user can sign in from any device and always
 * derive the same wallet address. Mounted at /api/auth/*.
 *
 * Registration semantics (the `name` given to /register/options is ALWAYS the username —
 * it is what the OS shows as the passkey's label):
 *  - no session on the request  → a NEW identity with that username, wallet "Main"
 *  - a session on the request   → a NEW WALLET for that identity; its label was parked via
 *                                  POST /api/wallets/pending-label just before the ceremony
 * Throwing from onRegister makes the SDK reject the ceremony and drop the credential,
 * which is how a taken/invalid username is refused.
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
      onRegister: async ({ credentialId, publicKey, name, request }) => {
        const address = addressFromPublicKey(publicKey);
        const session = await handler!.getSession(request);
        const owner = session ? await identityOfWallet(addressFromPublicKey(session.publicKey)) : null;
        if (owner && session) {
          // The ceremony's `name` is the username (the passkey's OS label); the wallet label was parked by the client.
          const parked = (await pgKv.take?.<string>(pendingLabelKey(session.credentialId))) ?? "";
          await addWalletToIdentity({ identityId: owner.id, address, credentialId, label: parked });
        } else {
          await createIdentityWithWallet({ username: name ?? "", address, credentialId });
        }
      },
      onAuthenticate: async ({ credentialId, publicKey }) => {
        await ensureIdentity(addressFromPublicKey(publicKey), credentialId);
      },
    });
  }
  return handler;
}

export type SessionUser = { address: `0x${string}`; credentialId: string; identityId: string; username: string };

/**
 * Resolves who the request acts for: the session's own wallet, or — via the
 * `x-wallet` header — any other wallet of the same identity. Null if signed out
 * or the requested wallet belongs to someone else.
 */
export async function getSessionUser(req: Request): Promise<SessionUser | null> {
  const session = await webAuthnHandler().getSession(req);
  if (!session) return null;
  const sessionAddress = addressFromPublicKey(session.publicKey);
  const identity = (await identityOfWallet(sessionAddress)) ?? (await ensureIdentity(sessionAddress, session.credentialId).then(() => identityOfWallet(sessionAddress)));
  if (!identity) return null;
  const requested = req.headers.get("x-wallet")?.trim().toLowerCase();
  if (!requested || requested === sessionAddress) {
    return { address: sessionAddress, credentialId: session.credentialId, identityId: identity.id, username: identity.username };
  }
  if (!/^0x[0-9a-f]{40}$/.test(requested)) return null;
  const wallets = await walletsOf(identity.id);
  if (!canActFor(sessionAddress, requested, wallets)) return null;
  const w = wallets.find((x) => x.address === requested)!;
  return { address: w.address, credentialId: w.credentialId, identityId: identity.id, username: identity.username };
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
