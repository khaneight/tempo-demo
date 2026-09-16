import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Hex } from "viem";
import { db } from "@/db";
import { offrampOrders, type OfframpOrder } from "@/db/schema";
import { HttpError } from "./http-error";
import { chain as defaultChain, type Chain, type MemoTransfer, ZERO } from "./chain";
import { creditPayout, type Bank } from "./fiat-stub";
import { memoFromOrderId } from "./memo";
import { nonceKeyFor } from "./nonce-key";
import { assertCurrentToken, isUniqueViolation, lockOrder, transition } from "./orders-db";

/**
 * Offramp: user transfers AcmeUSD to the treasury (signed with their passkey,
 * fee paid in AcmeUSD) -> we verify the transfer from the receipt LOGS ->
 * pay out fake USD -> burn the tokens from treasury.
 *
 *   created -> transfer_verified -> credited -> burning -> burned
 *      |                                          |
 *      +-> expired (re-opens if a transfer shows) +-> credited (retry)
 *   any verify mismatch -> needs_review (never auto-credited)
 *
 * The user is made whole at `credited`; a failed burn only overstates supply
 * until it is retried, which the admin reconciliation surfaces.
 */

export const MAX_BURN_ATTEMPTS = 5;
export const IN_PROGRESS_WINDOW_MS = 60_000;
export const OFFRAMP_TTL_MS = 24 * 60 * 60 * 1000;

export type Deps = {
  chain: Chain;
  fiat: { creditPayout: typeof creditPayout };
  now: () => Date;
};
export const defaultDeps = (): Deps => ({ chain: defaultChain(), fiat: { creditPayout }, now: () => new Date() });

export type ProcessResult = { order: OfframpOrder; inProgress: boolean; message?: string };

export async function createOfframp(
  p: { userAddress: `0x${string}`; amount: bigint; bank: Bank },
  deps: Deps = defaultDeps(),
): Promise<OfframpOrder> {
  const id = randomUUID();
  const createdBlock = await deps.chain.getBlockNumber();
  const [row] = await db
    .insert(offrampOrders)
    .values({
      id,
      userAddress: p.userAddress,
      token: deps.chain.token,
      amount: p.amount,
      memo: memoFromOrderId(id),
      createdBlock,
      expiresAt: new Date(deps.now().getTime() + OFFRAMP_TTL_MS),
      payoutDetails: { accountName: p.bank.accountName, last4: p.bank.account.slice(-4) },
    })
    .returning();
  return row;
}

export async function listOfframps(userAddress: string, token: string = defaultChain().token) {
  return db.query.offrampOrders.findMany({
    where: and(eq(offrampOrders.userAddress, userAddress), eq(offrampOrders.token, token)),
    orderBy: desc(offrampOrders.createdAt),
    limit: 50,
  });
}

export async function getOfframp(id: string, userAddress?: string) {
  return db.query.offrampOrders.findFirst({
    where: userAddress ? and(eq(offrampOrders.id, id), eq(offrampOrders.userAddress, userAddress)) : eq(offrampOrders.id, id),
  });
}

/**
 * Pure verification of a candidate transfer against an order. Everything is
 * taken from the on-chain log, never from the client.
 *
 * Only transfers *from the order owner* can affect the order: an exact match
 * verifies it, an owner transfer with the wrong amount/recipient parks it for
 * review. Transfers from anyone else that happen to carry the memo are ignored,
 * so a third party who learns a memo cannot wedge the order.
 */
export function verifyTransfer(
  order: Pick<OfframpOrder, "memo" | "userAddress" | "amount">,
  treasury: string,
  transfers: MemoTransfer[],
): { ok: true; transfer: MemoTransfer } | { ok: false; reason: string; transfer?: MemoTransfer } {
  const owner = order.userAddress.toLowerCase();
  const mine = transfers.filter((x) => x.memo === order.memo.toLowerCase() && x.from === owner);
  if (mine.length === 0) return { ok: false, reason: "no transfer from you with this order's memo" };
  const exact = mine.find((x) => x.to === treasury.toLowerCase() && x.amount === order.amount);
  if (exact) return { ok: true, transfer: exact };
  const x = mine[0];
  if (x.to !== treasury.toLowerCase()) return { ok: false, reason: `recipient ${x.to} is not the treasury`, transfer: x };
  return { ok: false, reason: `amount ${x.amount} does not match order amount ${order.amount}`, transfer: x };
}

const t = (id: string, from: readonly OfframpOrder["status"][], set: Partial<typeof offrampOrders.$inferInsert>) =>
  transition(db, offrampOrders, id, from, set);

export async function processOfframp(id: string, opts: { txHash?: Hex } = {}, deps: Deps = defaultDeps()): Promise<ProcessResult> {
  // Phase 1 — decide under lock.
  const decision = await db.transaction(async (tx) => {
    const order = await lockOrder(tx, offrampOrders, id);
    assertCurrentToken(order, deps.chain.token);
    switch (order.status) {
      case "burned":
      case "needs_review":
        return { type: "done" as const, order };
      case "created":
      case "expired":
        return { type: "verify" as const, order };
      case "transfer_verified":
        return { type: "credit" as const, order };
      case "credited":
      case "burning":
        return { type: "burn" as const, order }; // claimed under lock in Phase 4
    }
  });
  if (decision.type === "done") return { order: decision.order, inProgress: false };
  let order = decision.order;

  // Phase 2 — verify the user's transfer (from a submitted hash, or by memo lookup).
  if (decision.type === "verify") {
    let transfers: MemoTransfer[] = [];
    if (opts.txHash) {
      const receipt = await deps.chain.getReceiptTransfers(opts.txHash);
      if (!receipt) return { order, inProgress: true, message: "Transaction not found yet" };
      if (receipt.status !== "success") return { order, inProgress: false, message: "Transaction reverted" };
      transfers = receipt.transfers;
    } else {
      transfers = await deps.chain.findTransfersByMemo({ memo: order.memo as Hex, fromBlock: order.createdBlock });
    }
    const v = verifyTransfer(order, deps.chain.treasury, transfers);
    if (!v.ok) {
      if (v.transfer) {
        // A transfer carrying our memo exists but is wrong: park it for a human. Tokens are safe in treasury (or elsewhere).
        const parked = await t(id, ["created", "expired"], {
          status: "needs_review",
          transferTxHash: v.transfer.txHash,
          transferFrom: v.transfer.from,
          transferAmount: v.transfer.amount,
          lastError: v.reason,
        }).catch((err) => (isUniqueViolation(err) ? null : Promise.reject(err)));
        return { order: parked ?? (await reread(id)), inProgress: false, message: v.reason };
      }
      if (order.status === "created" && deps.now() > order.expiresAt) {
        const expired = await t(id, ["created"], { status: "expired" });
        return { order: expired ?? order, inProgress: false, message: "No transfer found; order expired" };
      }
      return { order, inProgress: false, message: "Waiting for your transfer" };
    }
    let verified: OfframpOrder | null;
    try {
      verified = await t(id, ["created", "expired"], {
        status: "transfer_verified",
        transferTxHash: v.transfer.txHash,
        transferFrom: v.transfer.from,
        transferAmount: v.transfer.amount,
        lastError: null,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // This receipt already satisfied another order. Cannot happen for a well-formed memo, but never credit twice.
      const parked = await t(id, ["created", "expired"], { status: "needs_review", lastError: `tx ${v.transfer.txHash} already used by another order` });
      return { order: parked ?? (await reread(id)), inProgress: false, message: "Transaction already used" };
    }
    order = verified ?? (await reread(id));
    if (order.status !== "transfer_verified") return { order, inProgress: false };
  }

  // Phase 3 — credit fiat exactly once (guarded by status inside a transaction).
  if (order.status === "transfer_verified") {
    order = await db.transaction(async (tx) => {
      const locked = await lockOrder(tx, offrampOrders, id);
      if (locked.status !== "transfer_verified") return locked;
      const { ref } = await deps.fiat.creditPayout({ orderId: id, amount: locked.amount, last4: locked.payoutDetails?.last4 });
      const credited = await transition(tx, offrampOrders, id, ["transfer_verified"], {
        status: "credited",
        creditedAt: deps.now(),
        payoutRef: ref,
      });
      return credited ?? locked;
    });
    if (order.status !== "credited") return { order, inProgress: false };
  }

  // Phase 4 — claim the burn slot under lock (same reasoning as the mint claim), then
  // recover-first / nonce-key / send.
  const claim = await db.transaction(async (tx) => {
    const locked = await lockOrder(tx, offrampOrders, id);
    if (locked.status === "burning") {
      const age = deps.now().getTime() - (locked.burnStartedAt?.getTime() ?? 0);
      if (age < IN_PROGRESS_WINDOW_MS) return { type: "inProgress" as const, order: locked };
    } else if (locked.status !== "credited") {
      return { type: "done" as const, order: locked };
    }
    const claimed = await transition(tx, offrampOrders, id, ["credited", "burning"], { status: "burning", burnStartedAt: deps.now() });
    return { type: "burn" as const, order: claimed ?? locked };
  });
  if (claim.type !== "burn") return { order: claim.order, inProgress: claim.type === "inProgress" };
  order = claim.order;

  const recovered = await recoverBurn(order, deps);
  if (recovered) return { order: recovered, inProgress: false };

  const attempt = order.burnAttempt;
  const nonceKey = nonceKeyFor(id, attempt);
  if ((await deps.chain.getNonce(nonceKey)) > 0n) {
    const reviewed = await t(id, ["burning"], {
      status: "needs_review",
      lastError: `burn attempt ${attempt} consumed its nonce but no burn with this memo was found (user already credited)`,
    });
    return { order: reviewed ?? (await reread(id)), inProgress: false };
  }

  const outcome = await deps.chain.burnWithMemo({ amount: order.amount, memo: order.memo as Hex, nonceKey });
  switch (outcome.kind) {
    case "success": {
      const done = await t(id, ["burning"], { status: "burned", burnTxHash: outcome.txHash, completedAt: deps.now(), lastError: null });
      return { order: done ?? (await reread(id)), inProgress: false };
    }
    case "reverted":
      return retryOrReview(id, attempt + 1, `burn reverted: ${outcome.reason}`, "credited");
    case "rejected": {
      if (outcome.nonceTooLow) {
        const found = await recoverBurn(order, deps);
        if (found) return { order: found, inProgress: false };
        const reviewed = await t(id, ["burning"], { status: "needs_review", lastError: `nonce too low but no burn found: ${outcome.reason}` });
        return { order: reviewed ?? (await reread(id)), inProgress: false };
      }
      // Pre-broadcast rejection (deterministic reverts land here): count it, back off via the window.
      return retryOrReview(id, attempt + 1, `burn rejected: ${outcome.reason}`, "burning");
    }
    case "unknown": {
      const stuck = await t(id, ["burning"], { lastError: `burn outcome unknown: ${outcome.reason}` });
      return { order: stuck ?? (await reread(id)), inProgress: true };
    }
  }
}

/** Bounded burn retries. The user is already paid; exhausting attempts parks the order for an operator. */
async function retryOrReview(id: string, next: number, reason: string, retryStatus: "credited" | "burning"): Promise<ProcessResult> {
  const exhausted = next >= MAX_BURN_ATTEMPTS;
  const back = await t(id, ["burning"], {
    status: exhausted ? "needs_review" : retryStatus,
    burnAttempt: next,
    lastError: exhausted ? `${reason}; giving up after ${next} attempts (user already credited)` : reason,
  });
  return { order: back ?? (await reread(id)), inProgress: !exhausted && retryStatus === "burning" };
}

async function recoverBurn(order: OfframpOrder, deps: Deps): Promise<OfframpOrder | null> {
  const transfers = await deps.chain.findTransfersByMemo({ memo: order.memo as Hex, fromBlock: order.createdBlock });
  const burn = transfers.find((x) => x.from === deps.chain.treasury && x.to === ZERO && x.amount === order.amount);
  if (!burn) return null;
  const done = await t(order.id, ["credited", "burning"], {
    status: "burned",
    burnTxHash: burn.txHash,
    completedAt: deps.now(),
    lastError: null,
  });
  return done ?? (await reread(order.id));
}

async function reread(id: string): Promise<OfframpOrder> {
  const row = await db.query.offrampOrders.findFirst({ where: eq(offrampOrders.id, id) });
  if (!row) throw new HttpError(404, "Order not found");
  return row;
}
