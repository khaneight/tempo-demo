import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { getAbiItem } from "viem";
import { Abis } from "viem/tempo";
import { db } from "@/db";
import { offrampOrders, onrampOrders, users } from "@/db/schema";
import { chain as defaultChain, type Chain, FEE_MANAGER, ZERO } from "./chain";
import { env } from "./env";
import { pgKv } from "./kv-postgres";
import { getOrder, listByStatus, OrderLockedError, transition } from "./orders-db";
import { processOfframp, type Deps as OfframpDeps } from "./offramp";
import { processOnramp, type Deps as OnrampDeps } from "./onramp";

/**
 * ACME's liabilities, computed live from both sources of truth and reconciled.
 *
 *  - User liabilities  = AcmeUSD in circulation (per-user balances, total supply)
 *  - Corporate         = fiat we hold (Σ onramps minted − Σ offramps paid out)
 *                        and what we still owe in each direction.
 */
export type Liabilities = {
  /** feeAmmBalance: AcmeUSD collected as network fees (users pay fees in AcmeUSD; the Fee AMM holds them; ACME is the LP). */
  chain: { totalSupply: bigint; treasuryBalance: bigint; feeAmmBalance: bigint };
  /** Registered wallets (passkeys created here). */
  users: { address: string; balance: bigint; createdAt: Date }[];
  /** Addresses that have ever received AcmeUSD but never registered here (P2P recipients, other apps); top 200 by balance. */
  unknownHolders: { address: string; balance: bigint }[];
  /** Sum over ALL unknown holders (not just the listed ones). */
  unknownTotal: bigint;
  /** Block up to which the holder set has been indexed; 0 = index unavailable (RPC failure) → treat holder data as stale. */
  holdersSyncedBlock: bigint;
  /** Wall-clock time this snapshot was computed (ms). */
  fetchedAt: number;
  fiat: { reservesHeld: bigint; tokensOwed: bigint; fiatOwed: bigint; pendingBurns: bigint; expectedSupply: bigint };
  counts: { onramp: Record<string, number>; offramp: Record<string, number> };
  reconciliation: {
    /** totalSupply − (Σ minted − Σ burned). 0 = every unit in existence was issued through the ledger. */
    supplyDrift: bigint;
    /** treasuryBalance − pendingBurns. Deposits we can't attribute to a credited order. */
    unattributedTreasury: bigint;
    /** Σ user balances + treasury + fee AMM − totalSupply. AcmeUSD held by non-users (P2P to outsiders). */
    heldByOutsiders: bigint;
  };
  needsReview: { onramp: (typeof onrampOrders.$inferSelect)[]; offramp: (typeof offrampOrders.$inferSelect)[] };
};

async function sumByStatus(table: typeof onrampOrders | typeof offrampOrders, token: string) {
  const rows = await db
    .select({ status: table.status, total: sql<string>`coalesce(sum(${table.amount}), 0)`, n: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.token, token))
    .groupBy(table.status);
  const totals: Record<string, bigint> = {};
  const counts: Record<string, number> = {};
  for (const r of rows) {
    totals[r.status] = BigInt(r.total);
    counts[r.status] = r.n;
  }
  const sum = (...s: string[]) => s.reduce((a, k) => a + (totals[k] ?? 0n), 0n);
  return { sum, counts };
}

const transferEvent = getAbiItem({ abi: Abis.tip20, name: "Transfer" });
const HOLDER_CHUNK = 50_000n;

/**
 * Every address that has ever received this token, indexed incrementally from
 * the token's deploy block (cursor + set kept in the kv table). Lets the admin
 * page list holders that never registered here — the "outsiders" the
 * reconciliation otherwise only reports as a number.
 */
export async function syncHolders(ch: Chain, deployBlock: bigint): Promise<{ holders: string[]; block: bigint }> {
  const key = `holders:${ch.token.toLowerCase()}`;
  const prev = await pgKv.get<{ block: string; holders: string[] }>(key);
  const latest = await ch.client.getBlockNumber();
  const holders = new Set(prev?.holders ?? []);
  let from = prev ? BigInt(prev.block) + 1n : deployBlock;
  while (from <= latest) {
    const to = from + HOLDER_CHUNK - 1n < latest ? from + HOLDER_CHUNK - 1n : latest;
    const logs = (await ch.client.getLogs({ address: ch.token, event: transferEvent, fromBlock: from, toBlock: to })) as { args: { to?: string } }[];
    for (const l of logs) if (l.args?.to) holders.add(l.args.to.toLowerCase());
    from = to + 1n;
  }
  await pgKv.set(key, { block: latest.toString(), holders: [...holders] });
  return { holders: [...holders], block: latest };
}

export async function computeLiabilities(ch: Chain = defaultChain(), deployBlock: bigint = env().TOKEN_DEPLOY_BLOCK): Promise<Liabilities> {
  const token = ch.token;
  const [on, off, userRows, totalSupply, treasuryBalance, feeAmmBalance, holderIndex] = await Promise.all([
    sumByStatus(onrampOrders, token),
    sumByStatus(offrampOrders, token),
    db.select().from(users).orderBy(desc(users.createdAt)).limit(1000),
    ch.totalSupply(),
    ch.balanceOf(ch.treasury),
    ch.balanceOf(FEE_MANAGER),
    syncHolders(ch, deployBlock).catch((err) => {
      console.warn("[admin] holder sync failed:", (err as Error).message.split("\n")[0]);
      return { holders: [] as string[], block: 0n };
    }),
  ]);
  const balances = await Promise.all(userRows.map((u) => ch.balanceOf(u.address as `0x${string}`)));
  const userList = userRows.map((u, i) => ({ address: u.address, balance: balances[i], createdAt: u.createdAt }));

  const known = new Set([...userRows.map((u) => u.address.toLowerCase()), ch.treasury.toLowerCase(), FEE_MANAGER, ZERO]);
  const unknownAddrs = holderIndex.holders.filter((a) => !known.has(a));
  const unknownBalances = await Promise.all(unknownAddrs.map((a) => ch.balanceOf(a as `0x${string}`)));
  const unknownAll = unknownAddrs.map((address, i) => ({ address, balance: unknownBalances[i] })).sort((a, b) => Number(b.balance - a.balance));
  const unknownTotal = unknownAll.reduce((a, u) => a + u.balance, 0n);
  const unknownHolders = unknownAll.slice(0, 200);

  // needs_review rows are money in flight too: an onramp under review has captured fiat (tokens owed);
  // an offramp under review that was already credited has paid out fiat and still holds tokens to burn.
  const [reviewCredited] = await db
    .select({ total: sql<string>`coalesce(sum(${offrampOrders.amount}), 0)` })
    .from(offrampOrders)
    .where(and(eq(offrampOrders.status, "needs_review"), isNotNull(offrampOrders.creditedAt), eq(offrampOrders.token, token)));
  const reviewPaid = BigInt(reviewCredited.total);

  const minted = on.sum("minted");
  const burned = off.sum("burned");
  const paidOut = off.sum("credited", "burning", "burned") + reviewPaid;
  const pendingBurns = off.sum("credited", "burning") + reviewPaid;
  const expectedSupply = minted - burned;
  const sumUsers = userList.reduce((a, u) => a + u.balance, 0n);

  const [onReview, offReview] = await Promise.all([
    listByStatus(onrampOrders, ["needs_review"], token),
    listByStatus(offrampOrders, ["needs_review"], token),
  ]);

  return {
    chain: { totalSupply, treasuryBalance, feeAmmBalance },
    users: userList,
    unknownHolders,
    unknownTotal,
    holdersSyncedBlock: holderIndex.block,
    fetchedAt: Date.now(),
    fiat: {
      reservesHeld: minted - paidOut,
      tokensOwed: on.sum("payment_captured", "minting", "needs_review"),
      fiatOwed: off.sum("transfer_verified"),
      pendingBurns,
      expectedSupply,
    },
    counts: { onramp: on.counts, offramp: off.counts },
    reconciliation: {
      // Fees paid in AcmeUSD move tokens from users to the Fee AMM; they do NOT change supply,
      // so they must not be netted out here. Any non-zero value is issuance the ledger never saw.
      supplyDrift: totalSupply - expectedSupply,
      unattributedTreasury: treasuryBalance - pendingBurns,
      // The Fee AMM's AcmeUSD is ACME's fee revenue (ACME is the LP): known, not "outsiders".
      heldByOutsiders: sumUsers + treasuryBalance + feeAmmBalance - totalSupply,
    },
    needsReview: { onramp: onReview, offramp: offReview },
  };
}

/**
 * Operator exit from `needs_review` after a human has looked: put the order back on its
 * automated path with a fresh attempt (fresh nonce key). Nothing is minted/burned/paid here.
 *  - onramp  → payment_captured (fiat is still held; the mint will be retried)
 *  - offramp → credited if the user was already paid (retry the burn), else created (re-verify)
 */
export async function reopenOrder(kind: "onramp" | "offramp", id: string) {
  const note = "reopened by operator";
  if (kind === "onramp") {
    const row = await getOrder(onrampOrders, id);
    if (!row) return null;
    return transition(db, onrampOrders, id, ["needs_review"], { status: "payment_captured", mintAttempt: row.mintAttempt + 1, lastError: note });
  }
  const row = await getOrder(offrampOrders, id);
  if (!row) return null;
  if (row.creditedAt) {
    return transition(db, offrampOrders, id, ["needs_review"], { status: "credited", burnAttempt: row.burnAttempt + 1, lastError: note });
  }
  return transition(db, offrampOrders, id, ["needs_review"], {
    status: "created",
    transferTxHash: null,
    transferFrom: null,
    transferAmount: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    lastError: note,
  });
}

/** Sweep: re-drive every non-terminal order. Safe to run any time; skips rows currently locked. */
export async function reprocessStuck(olderThanMs = 60_000, deps: { onramp?: OnrampDeps; offramp?: OfframpDeps } = {}) {
  const cutoff = Date.now() - olderThanMs;
  // Housekeeping: expired passkey challenges/sessions are otherwise only lazily ignored.
  await db.execute(sql`delete from kv where expires_at is not null and expires_at <= now()`);
  const token = (deps.onramp?.chain ?? deps.offramp?.chain ?? defaultChain()).token;
  const onramps = (await listByStatus(onrampOrders, ["created", "payment_captured", "minting"], token)).filter(
    (o) => o.updatedAt.getTime() < cutoff,
  );
  const offramps = (await listByStatus(offrampOrders, ["created", "transfer_verified", "credited", "burning"], token)).filter(
    (o) => o.updatedAt.getTime() < cutoff,
  );
  const results: { kind: "onramp" | "offramp"; id: string; before: string; after: string }[] = [];
  // The route has a 60 s ceiling: stop early and let the next sweep continue rather than lose the result list.
  const deadline = Date.now() + 45_000;
  for (const o of onramps) {
    if (Date.now() > deadline) break;
    try {
      const r = await processOnramp(o.id, deps.onramp);
      results.push({ kind: "onramp", id: o.id, before: o.status, after: r.order.status });
    } catch (err) {
      if (!(err instanceof OrderLockedError)) results.push({ kind: "onramp", id: o.id, before: o.status, after: `error: ${(err as Error).message}` });
    }
  }
  for (const o of offramps) {
    if (Date.now() > deadline) break;
    try {
      const r = await processOfframp(o.id, {}, deps.offramp);
      results.push({ kind: "offramp", id: o.id, before: o.status, after: r.order.status });
    } catch (err) {
      if (!(err instanceof OrderLockedError)) results.push({ kind: "offramp", id: o.id, before: o.status, after: `error: ${(err as Error).message}` });
    }
  }
  return results;
}
