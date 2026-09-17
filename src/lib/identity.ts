import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { identities, users, type Identity } from "@/db/schema";
import { isUniqueViolation } from "./orders-db";

/**
 * Identities: a username owning one or more passkey wallets.
 *
 *  - Registration = username + first passkey  → identity + wallet "Main"
 *  - "Add a wallet" while signed in           → new passkey attached to the same identity
 *  - Sign in                                  → any of the identity's passkeys
 *
 * Authorization follows from this: a session established by any wallet of an
 * identity may act for any wallet of that identity (`canActFor`).
 */

export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,23}$/;

/** kv key holding the label a signed-in session chose for the wallet it is about to register. */
export const pendingLabelKey = (sessionCredentialId: string) => `pending-label:${sessionCredentialId}`;

export class UsernameError extends Error {}

export function normalizeUsername(raw: string): string {
  const u = raw.trim().toLowerCase();
  if (!USERNAME_RE.test(u)) throw new UsernameError("Username must be 3–24 characters: letters, numbers, _ or -, starting with a letter or number");
  return u;
}

export async function usernameAvailable(raw: string): Promise<{ ok: boolean; reason?: string }> {
  let u: string;
  try {
    u = normalizeUsername(raw);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const [row] = await db.select({ id: identities.id }).from(identities).where(eq(identities.username, u));
  return row ? { ok: false, reason: "That username is taken" } : { ok: true };
}

export type WalletRow = { address: `0x${string}`; credentialId: string; label: string; createdAt: Date };

export async function walletsOf(identityId: string): Promise<WalletRow[]> {
  const rows = await db
    .select({ address: users.address, credentialId: users.credentialId, label: users.label, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.identityId, identityId))
    .orderBy(asc(users.createdAt));
  return rows as WalletRow[];
}

export async function identityOfWallet(address: string): Promise<(Identity & { wallet: WalletRow }) | null> {
  const [row] = await db
    .select({ id: identities.id, username: identities.username, createdAt: identities.createdAt, address: users.address, credentialId: users.credentialId, label: users.label, walletCreatedAt: users.createdAt })
    .from(users)
    .innerJoin(identities, eq(users.identityId, identities.id))
    .where(eq(users.address, address.toLowerCase()));
  if (!row) return null;
  return { id: row.id, username: row.username, createdAt: row.createdAt, wallet: { address: row.address as `0x${string}`, credentialId: row.credentialId, label: row.label, createdAt: row.walletCreatedAt } };
}

/** Registration: a brand-new identity with its first wallet. Throws UsernameError if invalid/taken. */
export async function createIdentityWithWallet(p: { username: string; address: `0x${string}`; credentialId: string }): Promise<Identity> {
  const username = normalizeUsername(p.username);
  try {
    return await db.transaction(async (tx) => {
      const [identity] = await tx.insert(identities).values({ username }).returning();
      await tx.insert(users).values({ address: p.address, credentialId: p.credentialId, identityId: identity.id, label: "Main" });
      return identity;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new UsernameError("That username is taken");
    throw err;
  }
}

/** "Add a wallet": a new passkey under an existing identity, with a person-chosen label. */
export async function addWalletToIdentity(p: { identityId: string; address: `0x${string}`; credentialId: string; label: string }): Promise<void> {
  const existing = await walletsOf(p.identityId);
  const label = p.label.trim() || `Wallet ${existing.length + 1}`;
  await db.insert(users).values({ address: p.address, credentialId: p.credentialId, identityId: p.identityId, label }).onConflictDoNothing({ target: users.address });
}

/** Wallets registered before identities existed get one on their next sign-in (username derived from the address). */
export async function ensureIdentity(address: `0x${string}`, credentialId: string): Promise<Identity> {
  const existing = await identityOfWallet(address);
  if (existing) return existing;
  const base = `user-${address.slice(2, 8)}`;
  for (let i = 0; i < 5; i++) {
    const username = i === 0 ? base : `${base}-${i}`;
    try {
      return await db.transaction(async (tx) => {
        const [identity] = await tx.insert(identities).values({ username }).returning();
        await tx
          .insert(users)
          .values({ address, credentialId, identityId: identity.id, label: "Main" })
          .onConflictDoUpdate({ target: users.address, set: { identityId: identity.id, label: "Main" } });
        return identity;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
  }
  throw new Error("could not allocate a username");
}

export async function renameWalletLabel(identityId: string, address: string, label: string): Promise<WalletRow | null> {
  const clean = label.trim().slice(0, 40);
  if (!clean) return null;
  const [row] = await db
    .update(users)
    .set({ label: clean })
    .where(eq(users.address, address.toLowerCase()))
    .returning({ address: users.address, credentialId: users.credentialId, label: users.label, createdAt: users.createdAt, identityId: users.identityId });
  if (!row || row.identityId !== identityId) return null;
  return row as WalletRow;
}

/** Pure: may a session for `sessionAddress` act for `requested`? Only if both belong to the same identity. */
export function canActFor(sessionAddress: string, requested: string, identityWallets: readonly { address: string }[]): boolean {
  const s = sessionAddress.toLowerCase();
  const r = requested.toLowerCase();
  if (s === r) return true;
  const set = new Set(identityWallets.map((w) => w.address.toLowerCase()));
  return set.has(s) && set.has(r);
}
