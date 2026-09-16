import { beforeEach, describe, expect, it, vi } from "vitest";
import { clock, makeUser, mockChain, resetDb } from "@/test/mock-chain";
import { createOnramp, DAILY_ONRAMP_CAP, MAX_MINT_ATTEMPTS, MAX_OPEN_ONRAMPS, processOnramp, type Deps } from "@/lib/onramp";
import { TREASURY } from "@/test/mock-chain";
import { OrderLockedError } from "@/lib/orders-db";
import { nonceKeyFor } from "@/lib/nonce-key";
import { HttpError } from "@/lib/http-error";

const card = { name: "Ada Lovelace", number: "4242424242424242", exp: "12/30", cvc: "123" };

function makeDeps() {
  const mock = mockChain();
  const clk = clock();
  const fiat = {
    capturePayment: vi.fn(async ({ orderId }: { orderId: string }) => ({ ref: `cap_${orderId.slice(0, 8)}` })),
    refundPayment: vi.fn(async ({ orderId }: { orderId: string }) => ({ ref: `rf_${orderId.slice(0, 8)}` })),
  };
  const deps: Deps = { chain: mock.chain, fiat, now: clk.now };
  return { mock, clk, fiat, deps };
}

describe("onramp", () => {
  beforeEach(resetDb);

  it("mints exactly once on the happy path", async () => {
    const { deps, mock, fiat } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 25_000_000n, idempotencyKey: "k1", card }, deps);
    expect(order.status).toBe("created");

    const r = await processOnramp(order.id, deps);
    expect(r.order.status).toBe("minted");
    expect(r.order.mintTxHash).toMatch(/^0x/);
    expect(mock.calls.mint).toBe(1);
    expect(fiat.capturePayment).toHaveBeenCalledTimes(1);

    // Re-driving a terminal order is a no-op.
    const again = await processOnramp(order.id, deps);
    expect(again.order.status).toBe("minted");
    expect(mock.calls.mint).toBe(1);
  });

  it("replays the same idempotency key to the same order; rejects another user's key", async () => {
    const { deps } = makeDeps();
    const user = await makeUser("aa");
    const a = await createOnramp({ userAddress: user, amount: 5_000_000n, idempotencyKey: "same", card }, deps);
    const b = await createOnramp({ userAddress: user, amount: 5_000_000n, idempotencyKey: "same", card }, deps);
    expect(b.id).toBe(a.id);
    const other = await makeUser("bb");
    await expect(createOnramp({ userAddress: other, amount: 5_000_000n, idempotencyKey: "same", card }, deps)).rejects.toBeInstanceOf(HttpError);
  });

  it("returns to payment_captured on revert and retries with a fresh nonce key", async () => {
    const { deps, mock } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 5_000_000n, idempotencyKey: "k", card }, deps);

    mock.mode.mint = "revert";
    const r1 = await processOnramp(order.id, deps);
    expect(r1.order.status).toBe("payment_captured");
    expect(r1.order.mintAttempt).toBe(1);
    expect(r1.order.lastError).toContain("reverted");

    mock.mode.mint = "success";
    const r2 = await processOnramp(order.id, deps);
    expect(r2.order.status).toBe("minted");
    expect(mock.calls.mint).toBe(2);
    // attempt 0's key was consumed by the revert; attempt 1's key by the success
    expect(await mock.chain.getNonce(nonceKeyFor(order.id, 0))).toBe(1n);
    expect(await mock.chain.getNonce(nonceKeyFor(order.id, 1))).toBe(1n);
  });

  it("recovers a mint whose response was lost, without sending twice", async () => {
    const { deps, mock, clk } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 7_000_000n, idempotencyKey: "k", card }, deps);

    mock.mode.mint = "unknown"; // tx lands, but we never hear back
    const r1 = await processOnramp(order.id, deps);
    expect(r1.order.status).toBe("minting");
    expect(r1.inProgress).toBe(true);

    // Inside the in-progress window: nobody re-sends.
    const r2 = await processOnramp(order.id, deps);
    expect(r2.inProgress).toBe(true);
    expect(mock.calls.mint).toBe(1);

    // After the window: recover by memo.
    clk.advance(61_000);
    mock.mode.mint = "success";
    const r3 = await processOnramp(order.id, deps);
    expect(r3.order.status).toBe("minted");
    expect(r3.order.mintTxHash).toBe(mock.transfers[0].txHash);
    expect(mock.calls.mint).toBe(1);
  });

  it("treats 'nonce too low' as 'already landed' and recovers the hash", async () => {
    const { deps, mock } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 7_000_000n, idempotencyKey: "k", card }, deps);
    // Attempt 0 landed but the process crashed before recording it. On retry the RPC we hit is
    // lagging: getNonce still says 0 and the first memo lookup is empty, so we re-send with the
    // same key -> protocol rejects "nonce too low" -> we look again and find the original mint.
    const landed = await mock.chain.mintWithMemo({ to: user, amount: 7_000_000n, memo: order.memo as `0x${string}`, nonceKey: nonceKeyFor(order.id, 0) });
    expect(landed.kind).toBe("success");
    mock.lag.nonce = true;
    mock.lag.memoMisses = 1;
    const r = await processOnramp(order.id, deps);
    expect(r.order.status).toBe("minted");
    expect(r.order.mintTxHash).toBe(mock.transfers[0].txHash);
    expect(mock.transfers).toHaveLength(1); // exactly one mint exists on-chain
  });

  it("parks for review when an attempt's nonce is consumed but no mint is visible", async () => {
    const { deps, mock } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 7_000_000n, idempotencyKey: "k", card }, deps);
    const landed = await mock.chain.mintWithMemo({ to: user, amount: 7_000_000n, memo: order.memo as `0x${string}`, nonceKey: nonceKeyFor(order.id, 0) });
    expect(landed.kind).toBe("success");
    mock.transfers.splice(0, 1); // the log is not visible (or the tx reverted): never guess
    const r = await processOnramp(order.id, deps);
    expect(r.order.status).toBe("needs_review");
    expect(mock.calls.mint).toBe(1);
  });

  it("fails and refunds after MAX_MINT_ATTEMPTS reverts", async () => {
    const { deps, mock, fiat } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 5_000_000n, idempotencyKey: "k", card }, deps);
    mock.mode.mint = "revert";
    let last;
    for (let i = 0; i < MAX_MINT_ATTEMPTS; i++) last = await processOnramp(order.id, deps);
    expect(last!.order.status).toBe("failed");
    expect(last!.order.refundedAt).not.toBeNull();
    expect(fiat.refundPayment).toHaveBeenCalledTimes(1);
    expect(mock.calls.mint).toBe(MAX_MINT_ATTEMPTS);
    // Terminal: no more sends.
    await processOnramp(order.id, deps);
    expect(mock.calls.mint).toBe(MAX_MINT_ATTEMPTS);
  });

  it("counts pre-broadcast rejections as attempts and backs off via the in-flight window", async () => {
    const { deps, mock, clk } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 5_000_000n, idempotencyKey: "k", card }, deps);
    mock.mode.mint = "reject"; // e.g. SupplyCapExceeded surfaces at gas estimation, before broadcast
    const r1 = await processOnramp(order.id, deps);
    expect(r1.order.status).toBe("minting"); // stays claimed: the window is the backoff
    expect(r1.order.mintAttempt).toBe(1);
    expect(r1.inProgress).toBe(true);
    // Inside the window nothing is re-sent, even with Retry hammering.
    const r2 = await processOnramp(order.id, deps);
    expect(r2.inProgress).toBe(true);
    expect(mock.calls.mint).toBe(1);
    clk.advance(61_000);
    mock.mode.mint = "success";
    const r3 = await processOnramp(order.id, deps);
    expect(r3.order.status).toBe("minted");
    expect(mock.calls.mint).toBe(2);
  });

  it("gives up and refunds after MAX attempts of deterministic (pre-broadcast) failures — no infinite loop", async () => {
    const { deps, mock, clk, fiat } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 5_000_000n, idempotencyKey: "k", card }, deps);
    mock.mode.mint = "reject";
    let last;
    for (let i = 0; i < MAX_MINT_ATTEMPTS; i++) {
      last = await processOnramp(order.id, deps);
      clk.advance(61_000);
    }
    expect(last!.order.status).toBe("failed");
    expect(last!.order.refundedAt).not.toBeNull();
    expect(fiat.refundPayment).toHaveBeenCalledTimes(1);
    expect(mock.calls.mint).toBe(MAX_MINT_ATTEMPTS);
    expect(mock.transfers).toHaveLength(0); // nothing was ever minted
  });

  it("parks for review when an attempt's nonce is consumed but nothing landed (hang), instead of guessing", async () => {
    const { deps, mock, clk } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 5_000_000n, idempotencyKey: "k", card }, deps);
    mock.mode.mint = "hang"; // nonce consumed on the node's side, response lost, tx never visible
    const r1 = await processOnramp(order.id, deps);
    expect(r1.order.status).toBe("minting");
    clk.advance(61_000);
    const r2 = await processOnramp(order.id, deps);
    expect(r2.order.status).toBe("needs_review");
    expect(mock.calls.mint).toBe(1);
  });

  it("resumes a claim that crashed before sending: same attempt, single send", async () => {
    const { deps, mock, clk } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 5_000_000n, idempotencyKey: "k", card }, deps);
    // Simulate: claimed `minting` then the process died before mintWithMemo was called.
    const { db } = await import("@/db");
    const { onrampOrders } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(onrampOrders).set({ status: "minting", mintStartedAt: new Date(clk.now().getTime() - 120_000), paymentRef: "cap_x" }).where(eq(onrampOrders.id, order.id));
    const r = await processOnramp(order.id, deps);
    expect(r.order.status).toBe("minted");
    expect(r.order.mintAttempt).toBe(0);
    expect(mock.calls.mint).toBe(1);
  });

  it("two processors racing past the decision phase still produce exactly one send", async () => {
    const { deps, mock } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 5_000_000n, idempotencyKey: "k", card }, deps);
    await processOnramp(order.id, { ...deps, chain: { ...mock.chain, mintWithMemo: async () => ({ kind: "rejected", reason: "warm-up", nonceTooLow: false }) } }).catch(() => {});
    // Now the order is `minting` (attempt 1) inside its window; make the memo lookup slow so a second
    // caller overlaps the first *after* Phase 1. The lock + claim must still let only one through.
    const slowChain = { ...mock.chain, findTransfersByMemo: async (p: { memo: `0x${string}`; fromBlock: bigint }) => { await new Promise((r) => setTimeout(r, 250)); return mock.chain.findTransfersByMemo(p); } };
    const clk2 = clock(Date.now() + 120_000);
    const d2 = { ...deps, chain: slowChain, now: clk2.now };
    const results = await Promise.allSettled([processOnramp(order.id, d2), processOnramp(order.id, d2)]);
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.order.status : (r.reason as Error).constructor.name));
    expect(statuses).toContain("minted");
    expect(mock.calls.mint).toBe(1);
    const final = await processOnramp(order.id, d2);
    expect(final.order.status).toBe("minted");
    expect(mock.transfers.filter((t) => t.memo === order.memo.toLowerCase())).toHaveLength(1);
  });

  it("never mistakes a user's own memo'd transfer for the mint (recovery requires from == 0x0)", async () => {
    const { deps, mock } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 7_000_000n, idempotencyKey: "k", card }, deps);
    // The user knows the memo (it's in the order) and moves 7.00 to themselves with it before we mint.
    mock.userTransfer(user, user, 7_000_000n, order.memo as `0x${string}`);
    // And a treasury→user transfer with the memo would not count either.
    mock.userTransfer(TREASURY, user, 7_000_000n, order.memo as `0x${string}`);
    const r = await processOnramp(order.id, deps);
    expect(r.order.status).toBe("minted");
    expect(mock.calls.mint).toBe(1); // a real mint happened; the fake ones were ignored
    const mint = mock.transfers.find((t) => t.txHash === r.order.mintTxHash);
    expect(mint?.from).toBe("0x0000000000000000000000000000000000000000");
  });

  it("enforces per-user abuse limits before capturing fiat", async () => {
    const { deps, fiat } = makeDeps();
    const user = await makeUser();
    for (let i = 0; i < MAX_OPEN_ONRAMPS; i++) {
      await createOnramp({ userAddress: user, amount: 1_000_000n, idempotencyKey: `open-${i}`, card }, deps);
    }
    await expect(createOnramp({ userAddress: user, amount: 1_000_000n, idempotencyKey: "one-too-many", card }, deps)).rejects.toMatchObject({ status: 429 });
    expect(fiat.capturePayment).not.toHaveBeenCalled();
    // Replaying an existing key is never counted as a new order.
    expect((await createOnramp({ userAddress: user, amount: 1_000_000n, idempotencyKey: "open-0", card }, deps)).idempotencyKey).toBe("open-0");
    // Daily cap on the amount, independent of the open-order count.
    const other = await makeUser("bb");
    await createOnramp({ userAddress: other, amount: DAILY_ONRAMP_CAP - 1_000_000n, idempotencyKey: "big", card }, deps);
    await expect(createOnramp({ userAddress: other, amount: 2_000_000n, idempotencyKey: "over", card }, deps)).rejects.toMatchObject({ status: 429 });
  });

  it("serializes concurrent processors with a row lock", async () => {
    const { deps, mock } = makeDeps();
    const user = await makeUser();
    const order = await createOnramp({ userAddress: user, amount: 5_000_000n, idempotencyKey: "k", card }, deps);
    // Slow capture so both calls overlap inside the locked transaction.
    deps.fiat.capturePayment = vi.fn(async ({ orderId }: { orderId: string }) => {
      await new Promise((r) => setTimeout(r, 300));
      return { ref: `cap_${orderId.slice(0, 8)}` };
    });
    const results = await Promise.allSettled([processOnramp(order.id, deps), processOnramp(order.id, deps)]);
    const locked = results.filter((r) => r.status === "rejected" && r.reason instanceof OrderLockedError);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(locked).toHaveLength(1);
    expect(ok).toHaveLength(1);
    expect(mock.calls.mint).toBe(1);
  });
});
