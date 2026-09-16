import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { onrampOrders, type OnrampOrder } from "@/db/schema";
import { and, gt, inArray, sql } from "drizzle-orm";
import { chain as defaultChain, type Chain, ZERO } from "./chain";
import { capturePayment, refundPayment, type Card } from "./fiat-stub";
import { memoFromOrderId } from "./memo";
import { nonceKeyFor } from "./nonce-key";
import { HttpError } from "./http-error";
import { lockOrder, transition } from "./orders-db";

/**
 * Onramp: fake USD in -> AcmeUSD minted to the user's wallet.
 *
 *   created -> payment_captured -> minting -> minted
 *                     ^              |
 *                     +-- reverted --+   (attempt++, MAX_ATTEMPTS -> failed + refund)
 *
 * `processOnramp` is idempotent and re-drivable: the UI "Retry" button, the
 * admin "Reprocess" button and the cron all call it. Safety comes from three
 * layers: (1) recover-by-memo before every send, (2) a per-(order, attempt)
 * 2D nonce key so the protocol itself refuses a duplicate, (3) status-guarded
 * DB transitions so a stale processor can never overwrite a newer state.
 */

export const MAX_MINT_ATTEMPTS = 5;
export const IN_PROGRESS_WINDOW_MS = 60_000;
/** Abuse limits: fiat is stubbed, so without these any passkey could mint without bound. */
export const MAX_OPEN_ONRAMPS = 5; // non-terminal orders per user
export const DAILY_ONRAMP_COUNT = 20; // orders per user per 24 h
export const DAILY_ONRAMP_CAP = 50_000_000_000n; // 50,000.00 per user per 24 h

export type Deps = {
  chain: Chain;
  fiat: { capturePayment: typeof capturePayment; refundPayment: typeof refundPayment };
  now: () => Date;
};
export const defaultDeps = (): Deps => ({
  chain: defaultChain(),
  fiat: { capturePayment, refundPayment },
  now: () => new Date(),
});

export type ProcessResult = { order: OnrampOrder; inProgress: boolean };

export async function createOnramp(
  p: { userAddress: `0x${string}`; amount: bigint; idempotencyKey: string; card: Card },
  deps: Deps = defaultDeps(),
): Promise<OnrampOrder> {
  // Replays of an existing key must not be counted against limits.
  const replay = await db.query.onrampOrders.findFirst({ where: eq(onrampOrders.idempotencyKey, p.idempotencyKey) });
  if (replay) {
    if (replay.userAddress !== p.userAddress) throw new HttpError(409, "Idempotency key already used");
    return replay;
  }
  await enforceLimits(p.userAddress, p.amount, deps.now());

  const id = randomUUID();
  const createdBlock = await deps.chain.getBlockNumber();
  const inserted = await db
    .insert(onrampOrders)
    .values({
      id,
      userAddress: p.userAddress,
      amount: p.amount,
      memo: memoFromOrderId(id),
      idempotencyKey: p.idempotencyKey,
      createdBlock,
      paymentDetails: { name: p.card.name, last4: p.card.number.slice(-4) },
    })
    .onConflictDoNothing({ target: onrampOrders.idempotencyKey })
    .returning();
  if (inserted[0]) return inserted[0];

  // Replayed request: hand back the original order (only to its owner).
  const existing = await db.query.onrampOrders.findFirst({
    where: eq(onrampOrders.idempotencyKey, p.idempotencyKey),
  });
  if (!existing || existing.userAddress !== p.userAddress) throw new HttpError(409, "Idempotency key already used");
  return existing;
}

async function enforceLimits(userAddress: string, amount: bigint, now: Date) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [open] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(onrampOrders)
    .where(and(eq(onrampOrders.userAddress, userAddress), inArray(onrampOrders.status, ["created", "payment_captured", "minting"])));
  if (open.n >= MAX_OPEN_ONRAMPS) throw new HttpError(429, `You have ${open.n} purchases still processing — wait for them to finish`);
  const [day] = await db
    .select({ n: sql<number>`count(*)::int`, total: sql<string>`coalesce(sum(${onrampOrders.amount}), 0)` })
    .from(onrampOrders)
    .where(and(eq(onrampOrders.userAddress, userAddress), gt(onrampOrders.createdAt, since), sql`${onrampOrders.status} <> 'failed'`));
  if (day.n >= DAILY_ONRAMP_COUNT) throw new HttpError(429, "Daily purchase limit reached (20 orders)");
  if (BigInt(day.total) + amount > DAILY_ONRAMP_CAP) throw new HttpError(429, "Daily purchase limit reached ($50,000)");
}

export async function listOnramps(userAddress: string) {
  return db.query.onrampOrders.findMany({
    where: eq(onrampOrders.userAddress, userAddress),
    orderBy: desc(onrampOrders.createdAt),
    limit: 50,
  });
}

export async function getOnramp(id: string, userAddress?: string) {
  return db.query.onrampOrders.findFirst({
    where: userAddress ? and(eq(onrampOrders.id, id), eq(onrampOrders.userAddress, userAddress)) : eq(onrampOrders.id, id),
  });
}

const t = (id: string, from: readonly OnrampOrder["status"][], set: Partial<typeof onrampOrders.$inferInsert>) =>
  transition(db, onrampOrders, id, from, set);

export async function processOnramp(id: string, deps: Deps = defaultDeps()): Promise<ProcessResult> {
  // Phase 1 — decide AND claim under a row lock (DB-only; the fiat stub is the only side effect).
  // Claiming the `minting` slot here means a concurrent caller sees `minting` with a fresh
  // mintStartedAt and backs off, so two callers can never both reach the send.
  const decision = await db.transaction(async (tx) => {
    let order = await lockOrder(tx, onrampOrders, id);
    if (order.status === "created") {
      const { ref } = await deps.fiat.capturePayment({ orderId: id, amount: order.amount, last4: order.paymentDetails?.last4 });
      order = (await transition(tx, onrampOrders, id, ["created"], { status: "payment_captured", paymentRef: ref })) ?? order;
    }
    if (order.status === "minted" || order.status === "failed" || order.status === "needs_review") return { type: "done" as const, order };
    if (order.status === "minting") {
      const age = deps.now().getTime() - (order.mintStartedAt?.getTime() ?? 0);
      if (age < IN_PROGRESS_WINDOW_MS) return { type: "inProgress" as const, order };
    }
    const claimed = await transition(tx, onrampOrders, id, ["payment_captured", "minting"], { status: "minting", mintStartedAt: deps.now() });
    return { type: "mint" as const, order: claimed ?? order };
  });
  if (decision.type === "done") return { order: decision.order, inProgress: false };
  if (decision.type === "inProgress") return { order: decision.order, inProgress: true };
  const order = decision.order;

  // Phase 2 — recover first: did a previous attempt already mint this order?
  const recovered = await recoverMint(order, deps);
  if (recovered) return { order: recovered, inProgress: false };

  // The current attempt's nonce consumed but no mint found => reverted-or-lost; never guess.
  const attempt = order.mintAttempt;
  const nonceKey = nonceKeyFor(id, attempt);
  if ((await deps.chain.getNonce(nonceKey)) > 0n) {
    const reviewed = await t(id, ["minting"], {
      status: "needs_review",
      lastError: `attempt ${attempt} consumed its nonce but no mint with this memo was found`,
    });
    return { order: reviewed ?? (await reread(id)), inProgress: false };
  }

  // Phase 3 — send. At most one inclusion per (order, attempt) is guaranteed by the nonce key.
  const outcome = await deps.chain.mintWithMemo({ to: order.userAddress as `0x${string}`, amount: order.amount, memo: order.memo as `0x${string}`, nonceKey });

  // Phase 4 — record.
  switch (outcome.kind) {
    case "success": {
      const done = await t(id, ["minting"], { status: "minted", mintTxHash: outcome.txHash, completedAt: deps.now(), lastError: null });
      return { order: done ?? (await reread(id)), inProgress: false };
    }
    case "reverted":
      // Included and reverted: this attempt's key is spent; the next attempt uses a fresh key.
      return failOrRetry(order, attempt + 1, `mint reverted: ${outcome.reason}`, "payment_captured", deps);
    case "rejected": {
      if (outcome.nonceTooLow) {
        // The earlier send with this key landed after all. Find it.
        const found = await recoverMint(order, deps);
        if (found) return { order: found, inProgress: false };
        const reviewed = await t(id, ["minting"], { status: "needs_review", lastError: `nonce too low for attempt ${attempt} but no mint found: ${outcome.reason}` });
        return { order: reviewed ?? (await reread(id)), inProgress: false };
      }
      // Never reached the mempool. Deterministic reverts (supply cap, paused, missing role) arrive
      // here too — gas estimation fails before broadcast — so they MUST count as attempts or the
      // order would loop forever. Staying `minting` makes the in-flight window act as backoff.
      return failOrRetry(order, attempt + 1, `mint rejected: ${outcome.reason}`, "minting", deps);
    }
    case "unknown": {
      const stuck = await t(id, ["minting"], { lastError: `mint outcome unknown: ${outcome.reason}` });
      return { order: stuck ?? (await reread(id)), inProgress: true };
    }
  }
}

/** Bounded retries: after MAX_MINT_ATTEMPTS the order fails and the fiat hold is released. */
async function failOrRetry(order: OnrampOrder, next: number, reason: string, retryStatus: "payment_captured" | "minting", deps: Deps): Promise<ProcessResult> {
  const id = order.id;
  if (next >= MAX_MINT_ATTEMPTS) {
    // Transition first so a crash mid-refund can never re-mint; the refund is idempotent per order id.
    const failed = await t(id, ["minting"], { status: "failed", mintAttempt: next, lastError: `${reason}; giving up after ${next} attempts`, completedAt: deps.now() });
    if (failed) {
      await deps.fiat.refundPayment({ orderId: id, amount: order.amount, paymentRef: order.paymentRef });
      const refunded = await t(id, ["failed"], { refundedAt: deps.now() });
      return { order: refunded ?? failed, inProgress: false };
    }
    return { order: await reread(id), inProgress: false };
  }
  const back = await t(id, ["minting"], { status: retryStatus, mintAttempt: next, lastError: reason });
  return { order: back ?? (await reread(id)), inProgress: retryStatus === "minting" };
}

async function recoverMint(order: OnrampOrder, deps: Deps): Promise<OnrampOrder | null> {
  const transfers = await deps.chain.findTransfersByMemo({ memo: order.memo as `0x${string}`, fromBlock: order.createdBlock });
  // A mint is a TransferWithMemo from the zero address. Anything else carrying this memo
  // (e.g. the user transferring to themselves with the memo) must not count as our mint.
  const mint = transfers.find((x) => x.from === ZERO && x.to === order.userAddress.toLowerCase() && x.amount === order.amount);
  if (!mint) return null;
  const done = await t(order.id, ["payment_captured", "minting"], {
    status: "minted",
    mintTxHash: mint.txHash,
    completedAt: deps.now(),
    lastError: null,
  });
  return done ?? (await reread(order.id));
}

async function reread(id: string): Promise<OnrampOrder> {
  const row = await db.query.onrampOrders.findFirst({ where: eq(onrampOrders.id, id) });
  if (!row) throw new HttpError(404, "Order not found");
  return row;
}
