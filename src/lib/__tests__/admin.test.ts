import { beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { db } from "@/db";
import { offrampOrders, onrampOrders } from "@/db/schema";
import { computeLiabilities, reprocessStuck } from "@/lib/admin";
import { FEE_MANAGER, type Chain } from "@/lib/chain";
import { memoFromOrderId } from "@/lib/memo";
import { makeUser, mockChain, resetDb, TREASURY } from "@/test/mock-chain";
import { randomUUID } from "node:crypto";

/** Chain whose balances/supply we dictate, on top of the mock's nonce+memo behaviour. */
function chainWith(balances: Record<string, bigint>, totalSupply: bigint): Chain {
  const base = mockChain().chain;
  return {
    ...base,
    balanceOf: async (a: Address) => balances[a.toLowerCase()] ?? 0n,
    totalSupply: async () => totalSupply,
  };
}

async function onramp(user: Address, amount: bigint, status: typeof onrampOrders.$inferInsert.status, extra: Partial<typeof onrampOrders.$inferInsert> = {}) {
  const id = randomUUID();
  await db.insert(onrampOrders).values({ id, userAddress: user, amount, memo: memoFromOrderId(id), idempotencyKey: id, status, createdBlock: 1n, ...extra });
  return id;
}
async function offramp(user: Address, amount: bigint, status: typeof offrampOrders.$inferInsert.status, extra: Partial<typeof offrampOrders.$inferInsert> = {}) {
  const id = randomUUID();
  await db.insert(offrampOrders).values({ id, userAddress: user, amount, memo: memoFromOrderId(id), status, createdBlock: 1n, expiresAt: new Date(Date.now() + 86_400_000), ...extra });
  return id;
}

describe("admin liabilities", () => {
  beforeEach(resetDb);

  it("computes corporate + user liabilities and the three reconciliations from ledger + chain", async () => {
    const alice = await makeUser("aa");
    const bob = await makeUser("bb");
    // Ledger: 100 minted to alice, 40 minted to bob, 10 owed (captured, not minted), 5 failed (refunded).
    await onramp(alice, 100_000_000n, "minted", { mintTxHash: ("0x" + "1".repeat(64)) as Hex });
    await onramp(bob, 40_000_000n, "minted", { mintTxHash: ("0x" + "2".repeat(64)) as Hex });
    await onramp(alice, 10_000_000n, "payment_captured");
    await onramp(alice, 5_000_000n, "failed");
    // Offramps: 30 burned, 20 credited (burn pending), 7 verified (payout pending), 3 needs_review.
    await offramp(alice, 30_000_000n, "burned", { transferTxHash: ("0x" + "3".repeat(64)) as Hex, burnTxHash: ("0x" + "4".repeat(64)) as Hex });
    await offramp(alice, 20_000_000n, "credited", { transferTxHash: ("0x" + "5".repeat(64)) as Hex });
    await offramp(bob, 7_000_000n, "transfer_verified", { transferTxHash: ("0x" + "6".repeat(64)) as Hex });
    await offramp(bob, 3_000_000n, "needs_review", { transferTxHash: ("0x" + "7".repeat(64)) as Hex, lastError: "amount mismatch" });

    // Chain: alice 43 (100 − 30 − 20 − 7 sent... she sent 57 total), bob 40 − 3 + ... keep it simple & consistent:
    // supply = minted 140 − burned 30 = 110. Treasury holds the 20 credited-not-burned, the 7 verified and the 3 under review = 30.
    // Fee AMM holds 0.5 of fees. Users hold the rest: 110 − 30 − 0.5 = 79.5 (alice 40, bob 39.5).
    const chain = chainWith(
      { [alice]: 40_000_000n, [bob]: 39_500_000n, [TREASURY]: 30_000_000n, [FEE_MANAGER]: 500_000n },
      110_000_000n,
    );
    const L = await computeLiabilities(chain);

    expect(L.chain.totalSupply).toBe(110_000_000n);
    expect(L.chain.treasuryBalance).toBe(30_000_000n);
    expect(L.chain.feeAmmBalance).toBe(500_000n);
    expect(L.users.map((u) => u.balance).reduce((a, b) => a + b, 0n)).toBe(79_500_000n);

    // Corporate: USD held = minted (140) − paid out (credited 20 + burned 30 = 50) = 90. Failed/refunded and verified-not-paid are excluded.
    expect(L.fiat.reservesHeld).toBe(90_000_000n);
    expect(L.fiat.tokensOwed).toBe(10_000_000n); // captured, mint pending
    expect(L.fiat.fiatOwed).toBe(7_000_000n); // verified, payout pending
    expect(L.fiat.pendingBurns).toBe(20_000_000n); // credited, burn pending
    expect(L.fiat.expectedSupply).toBe(110_000_000n);

    expect(L.reconciliation.supplyDrift).toBe(0n);
    // treasury 30 − pending burns 20 = 10 unattributed (the 7 verified-not-yet-paid + 3 needs_review)
    expect(L.reconciliation.unattributedTreasury).toBe(10_000_000n);
    // users 79.5 + treasury 30 + fee AMM 0.5 − supply 110 = 0 → nothing held by unknown wallets
    expect(L.reconciliation.heldByOutsiders).toBe(0n);

    expect(L.counts.onramp).toEqual({ minted: 2, payment_captured: 1, failed: 1 });
    expect(L.counts.offramp).toEqual({ burned: 1, credited: 1, transfer_verified: 1, needs_review: 1 });
    expect(L.needsReview.offramp).toHaveLength(1);
    expect(L.needsReview.onramp).toHaveLength(0);
  });

  it("counts needs_review money as in flight: captured-but-unminted fiat is owed; credited-but-unburned tokens are pending burns", async () => {
    const alice = await makeUser("aa");
    await onramp(alice, 100_000_000n, "minted", { mintTxHash: ("0x" + "1".repeat(64)) as Hex });
    await onramp(alice, 8_000_000n, "needs_review", { paymentRef: "cap_x", lastError: "nonce consumed, no mint" });
    await offramp(alice, 30_000_000n, "needs_review", { transferTxHash: ("0x" + "3".repeat(64)) as Hex, creditedAt: new Date(), payoutRef: "po_x", lastError: "burn failed 5x" });
    await offramp(alice, 2_000_000n, "needs_review", { transferTxHash: ("0x" + "4".repeat(64)) as Hex, lastError: "amount mismatch" });
    // Chain: supply 100 (nothing burned); treasury holds the 30 awaiting burn + the 2 under review.
    const chain = chainWith({ [alice]: 68_000_000n, [TREASURY]: 32_000_000n, [FEE_MANAGER]: 0n }, 100_000_000n);
    const L = await computeLiabilities(chain);
    expect(L.fiat.tokensOwed).toBe(8_000_000n);
    expect(L.fiat.reservesHeld).toBe(70_000_000n); // 100 minted − 30 paid out (the credited review row)
    expect(L.fiat.pendingBurns).toBe(30_000_000n);
    expect(L.reconciliation.supplyDrift).toBe(0n);
    expect(L.reconciliation.unattributedTreasury).toBe(2_000_000n); // only the un-credited review deposit
    expect(L.reconciliation.heldByOutsiders).toBe(0n);
  });

  it("reopenOrder puts a reviewed order back on its path with a fresh attempt, and only from needs_review", async () => {
    const { reopenOrder } = await import("@/lib/admin");
    const alice = await makeUser("aa");
    const on = await onramp(alice, 5_000_000n, "needs_review", { paymentRef: "cap_x", mintAttempt: 2 });
    const r1 = await reopenOrder("onramp", on);
    expect(r1).toMatchObject({ status: "payment_captured", mintAttempt: 3 });
    expect(await reopenOrder("onramp", on)).toBeNull(); // no longer needs_review

    const paid = await offramp(alice, 5_000_000n, "needs_review", { creditedAt: new Date(), burnAttempt: 5, transferTxHash: ("0x" + "5".repeat(64)) as Hex });
    expect(await reopenOrder("offramp", paid)).toMatchObject({ status: "credited", burnAttempt: 6 });
    const unpaid = await offramp(alice, 5_000_000n, "needs_review", { transferTxHash: ("0x" + "6".repeat(64)) as Hex, transferAmount: 1n });
    const r3 = await reopenOrder("offramp", unpaid);
    expect(r3).toMatchObject({ status: "created", transferTxHash: null, transferAmount: null });
    const minted = await onramp(alice, 1_000_000n, "minted", { mintTxHash: ("0x" + "7".repeat(64)) as Hex });
    expect(await reopenOrder("onramp", minted)).toBeNull();
  });

  it("flags supply drift when the chain has issuance the ledger never saw, and outsider holdings", async () => {
    const alice = await makeUser("aa");
    await onramp(alice, 25_000_000n, "minted", { mintTxHash: ("0x" + "1".repeat(64)) as Hex });
    // Chain says 25.000049 exist (49 units minted outside the ledger) and 5 sit in a wallet we don't know.
    const chain = chainWith({ [alice]: 20_000_049n, [TREASURY]: 0n, [FEE_MANAGER]: 0n }, 25_000_049n);
    const L = await computeLiabilities(chain);
    expect(L.reconciliation.supplyDrift).toBe(49n);
    expect(L.reconciliation.heldByOutsiders).toBe(-5_000_000n);
  });
});

describe("reprocessStuck", () => {
  beforeEach(resetDb);

  it("re-drives only non-terminal orders older than the cutoff, and completes them", async () => {
    const user = await makeUser("aa");
    const old = new Date(Date.now() - 5 * 60_000);
    const stuckMint = await onramp(user, 3_000_000n, "payment_captured", { updatedAt: old });
    const freshMint = await onramp(user, 4_000_000n, "payment_captured"); // updated just now: skipped this sweep
    const done = await onramp(user, 1_000_000n, "minted", { updatedAt: old, mintTxHash: ("0x" + "9".repeat(64)) as Hex });
    const review = await onramp(user, 2_000_000n, "needs_review", { updatedAt: old });

    const mock = mockChain();
    const fiat = {
      capturePayment: async ({ orderId }: { orderId: string }) => ({ ref: `cap_${orderId.slice(0, 8)}` }),
      refundPayment: async ({ orderId }: { orderId: string }) => ({ ref: `rf_${orderId.slice(0, 8)}` }),
      creditPayout: async ({ orderId }: { orderId: string }) => ({ ref: `po_${orderId.slice(0, 8)}` }),
    };
    const now = () => new Date();
    const results = await reprocessStuck(60_000, { onramp: { chain: mock.chain, fiat, now }, offramp: { chain: mock.chain, fiat, now } });
    const ids = results.map((r) => r.id);
    expect(ids).toContain(stuckMint);
    expect(ids).not.toContain(freshMint);
    expect(ids).not.toContain(done);
    expect(ids).not.toContain(review);
    expect(results.find((r) => r.id === stuckMint)).toMatchObject({ before: "payment_captured", after: "minted" });
    expect(mock.calls.mint).toBe(1);
  });
});
