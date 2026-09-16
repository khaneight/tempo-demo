import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { clock, makeUser, mockChain, resetDb, TREASURY } from "@/test/mock-chain";
import { createOfframp, processOfframp, verifyTransfer, type Deps } from "@/lib/offramp";
import { ZERO } from "@/lib/chain";

const bank = { accountName: "Ada Lovelace", routing: "021000021", account: "123456789" };

function makeDeps() {
  const mock = mockChain();
  const clk = clock();
  const fiat = { creditPayout: vi.fn(async ({ orderId }: { orderId: string }) => ({ ref: `po_${orderId.slice(0, 8)}` })) };
  const deps: Deps = { chain: mock.chain, fiat, now: clk.now };
  return { mock, clk, fiat, deps };
}

describe("verifyTransfer (pure)", () => {
  const order = { memo: ("0x" + "1".repeat(64)) as Hex, userAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", amount: 10_000_000n };
  const base = { txHash: "0xhash" as Hex, blockNumber: 1n, from: order.userAddress as Address, to: TREASURY, amount: 10_000_000n, memo: order.memo };

  it("accepts an exact match", () => {
    expect(verifyTransfer(order, TREASURY, [base]).ok).toBe(true);
  });
  it("ignores transfers with other memos", () => {
    const r = verifyTransfer(order, TREASURY, [{ ...base, memo: ("0x" + "2".repeat(64)) as Hex }]);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("transfer");
  });
  it("flags the owner's wrong-recipient / wrong-amount transfers for review", () => {
    expect(verifyTransfer(order, TREASURY, [{ ...base, to: ZERO }])).toMatchObject({ ok: false, reason: expect.stringContaining("treasury"), transfer: expect.anything() });
    expect(verifyTransfer(order, TREASURY, [{ ...base, amount: 9_999_999n }])).toMatchObject({ ok: false, reason: expect.stringContaining("amount"), transfer: expect.anything() });
  });
  it("ignores transfers from anyone but the owner, even with the right memo and amount (no third-party wedging)", () => {
    const r = verifyTransfer(order, TREASURY, [{ ...base, from: ZERO }]);
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("transfer");
    // ...and still finds the owner's exact match when both are present
    expect(verifyTransfer(order, TREASURY, [{ ...base, from: ZERO }, base]).ok).toBe(true);
  });
  it("picks the exact match when several logs share the memo", () => {
    const r = verifyTransfer(order, TREASURY, [{ ...base, amount: 1n }, base]);
    expect(r.ok && r.transfer.amount).toBe(10_000_000n);
  });
});

describe("offramp", () => {
  beforeEach(resetDb);

  it("verifies from the receipt, credits once, burns once", async () => {
    const { deps, mock, fiat } = makeDeps();
    const user = await makeUser();
    const order = await createOfframp({ userAddress: user, amount: 10_000_000n, bank }, deps);
    const t = mock.userTransfer(user, TREASURY, 10_000_000n, order.memo as Hex);

    const r = await processOfframp(order.id, { txHash: t.txHash }, deps);
    expect(r.order.status).toBe("burned");
    expect(r.order.transferTxHash).toBe(t.txHash);
    expect(r.order.burnTxHash).toMatch(/^0x/);
    expect(fiat.creditPayout).toHaveBeenCalledTimes(1);
    expect(mock.calls.burn).toBe(1);

    // Resubmitting the same hash (or anything) never credits twice.
    await processOfframp(order.id, { txHash: t.txHash }, deps);
    await processOfframp(order.id, {}, deps);
    expect(fiat.creditPayout).toHaveBeenCalledTimes(1);
    expect(mock.calls.burn).toBe(1);
  });

  it("finds the transfer by memo when the hash was lost", async () => {
    const { deps, mock } = makeDeps();
    const user = await makeUser();
    const order = await createOfframp({ userAddress: user, amount: 3_000_000n, bank }, deps);
    const waiting = await processOfframp(order.id, {}, deps);
    expect(waiting.order.status).toBe("created");
    expect(waiting.message).toMatch(/waiting/i);

    mock.userTransfer(user, TREASURY, 3_000_000n, order.memo as Hex);
    const r = await processOfframp(order.id, {}, deps);
    expect(r.order.status).toBe("burned");
  });

  it("parks mismatched transfers for review and never credits them", async () => {
    const { deps, mock, fiat } = makeDeps();
    const user = await makeUser("aa");
    const stranger = await makeUser("bb");

    const short = await createOfframp({ userAddress: user, amount: 10_000_000n, bank }, deps);
    const t1 = mock.userTransfer(user, TREASURY, 9_000_000n, short.memo as Hex);
    const r1 = await processOfframp(short.id, { txHash: t1.txHash }, deps);
    expect(r1.order.status).toBe("needs_review");
    expect(r1.order.transferAmount).toBe(9_000_000n);

    // A stranger sending with the memo neither credits nor wedges the order; the owner's real transfer still completes it.
    const spoof = await createOfframp({ userAddress: user, amount: 1_000_000n, bank }, deps);
    const t2 = mock.userTransfer(stranger, TREASURY, 1_000_000n, spoof.memo as Hex);
    const r2 = await processOfframp(spoof.id, { txHash: t2.txHash }, deps);
    expect(r2.order.status).toBe("created");
    expect(fiat.creditPayout).not.toHaveBeenCalled();
    expect(mock.calls.burn).toBe(0);
    mock.userTransfer(user, TREASURY, 1_000_000n, spoof.memo as Hex);
    const r3 = await processOfframp(spoof.id, {}, deps);
    expect(r3.order.status).toBe("burned");
    expect(r3.order.transferFrom).toBe(user);
    expect(fiat.creditPayout).toHaveBeenCalledTimes(1);
    expect(mock.calls.burn).toBe(1);

    // needs_review is terminal for automation.
    await processOfframp(short.id, {}, deps);
    expect((await processOfframp(short.id, {}, deps)).order.status).toBe("needs_review");
    expect(fiat.creditPayout).toHaveBeenCalledTimes(1); // only the spoof order's genuine transfer above
  });

  it("ignores reverted or unknown receipts", async () => {
    const { deps, mock } = makeDeps();
    const user = await makeUser();
    const order = await createOfframp({ userAddress: user, amount: 2_000_000n, bank }, deps);
    const rev = await processOfframp(order.id, { txHash: mock.revertedReceipt() }, deps);
    expect(rev.order.status).toBe("created");
    const unk = await processOfframp(order.id, { txHash: ("0x" + "9".repeat(64)) as Hex }, deps);
    expect(unk.order.status).toBe("created");
    expect(unk.inProgress).toBe(true);
  });

  it("expires, then re-opens if the transfer shows up late", async () => {
    const { deps, mock, clk } = makeDeps();
    const user = await makeUser();
    const order = await createOfframp({ userAddress: user, amount: 2_000_000n, bank }, deps);
    clk.advance(25 * 60 * 60 * 1000);
    const e = await processOfframp(order.id, {}, deps);
    expect(e.order.status).toBe("expired");
    mock.userTransfer(user, TREASURY, 2_000_000n, order.memo as Hex);
    const r = await processOfframp(order.id, {}, deps);
    expect(r.order.status).toBe("burned");
  });

  it("keeps the user credited when the burn reverts, and retries", async () => {
    const { deps, mock, fiat } = makeDeps();
    const user = await makeUser();
    const order = await createOfframp({ userAddress: user, amount: 4_000_000n, bank }, deps);
    mock.userTransfer(user, TREASURY, 4_000_000n, order.memo as Hex);
    mock.mode.burn = "revert";
    const r1 = await processOfframp(order.id, {}, deps);
    expect(r1.order.status).toBe("credited");
    expect(r1.order.burnAttempt).toBe(1);
    expect(fiat.creditPayout).toHaveBeenCalledTimes(1);

    mock.mode.burn = "success";
    const r2 = await processOfframp(order.id, {}, deps);
    expect(r2.order.status).toBe("burned");
    expect(fiat.creditPayout).toHaveBeenCalledTimes(1);
    expect(mock.calls.burn).toBe(2);
  });

  it("counts pre-broadcast burn rejections and parks for review after MAX attempts — user stays paid, paid once", async () => {
    const { deps, mock, clk, fiat } = makeDeps();
    const user = await makeUser();
    const order = await createOfframp({ userAddress: user, amount: 4_000_000n, bank }, deps);
    mock.userTransfer(user, TREASURY, 4_000_000n, order.memo as Hex);
    mock.mode.burn = "reject";
    let last;
    for (let i = 0; i < 5; i++) {
      last = await processOfframp(order.id, {}, deps);
      clk.advance(61_000);
    }
    expect(last!.order.status).toBe("needs_review");
    expect(last!.order.creditedAt).not.toBeNull();
    expect(fiat.creditPayout).toHaveBeenCalledTimes(1);
    expect(mock.calls.burn).toBe(5);
  });

  it("resumes from persisted transfer_verified and credited states (crash before credit / before burn)", async () => {
    const { deps, mock, fiat } = makeDeps();
    const user = await makeUser();
    const { db } = await import("@/db");
    const { offrampOrders } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");

    const a = await createOfframp({ userAddress: user, amount: 2_000_000n, bank }, deps);
    const ta = mock.userTransfer(user, TREASURY, 2_000_000n, a.memo as Hex);
    await db.update(offrampOrders).set({ status: "transfer_verified", transferTxHash: ta.txHash, transferFrom: user, transferAmount: 2_000_000n }).where(eq(offrampOrders.id, a.id));
    const ra = await processOfframp(a.id, {}, deps);
    expect(ra.order.status).toBe("burned");
    expect(fiat.creditPayout).toHaveBeenCalledTimes(1);

    const b = await createOfframp({ userAddress: user, amount: 3_000_000n, bank }, deps);
    const tb = mock.userTransfer(user, TREASURY, 3_000_000n, b.memo as Hex);
    await db.update(offrampOrders).set({ status: "credited", creditedAt: new Date(), payoutRef: "po_b", transferTxHash: tb.txHash, transferFrom: user, transferAmount: 3_000_000n }).where(eq(offrampOrders.id, b.id));
    const rb = await processOfframp(b.id, {}, deps);
    expect(rb.order.status).toBe("burned");
    expect(fiat.creditPayout).toHaveBeenCalledTimes(1); // not paid again
    expect(mock.calls.burn).toBe(2);
  });

  it("parallel submissions of the same hash credit once and burn once", async () => {
    const { deps, mock, fiat } = makeDeps();
    const user = await makeUser();
    const order = await createOfframp({ userAddress: user, amount: 6_000_000n, bank }, deps);
    const t = mock.userTransfer(user, TREASURY, 6_000_000n, order.memo as Hex);
    const slow = { ...mock.chain, getReceiptTransfers: async (h: Hex) => { await new Promise((r) => setTimeout(r, 200)); return mock.chain.getReceiptTransfers(h); } };
    const d = { ...deps, chain: slow };
    const results = await Promise.allSettled([processOfframp(order.id, { txHash: t.txHash }, d), processOfframp(order.id, { txHash: t.txHash }, d), processOfframp(order.id, {}, d)]);
    expect(results.some((r) => r.status === "fulfilled" && r.value.order.status === "burned")).toBe(true);
    const final = await processOfframp(order.id, {}, d);
    expect(final.order.status).toBe("burned");
    expect(fiat.creditPayout).toHaveBeenCalledTimes(1);
    expect(mock.calls.burn).toBe(1);
  });

  it("recovers a burn whose response was lost without burning twice", async () => {
    const { deps, mock, clk } = makeDeps();
    const user = await makeUser();
    const order = await createOfframp({ userAddress: user, amount: 4_000_000n, bank }, deps);
    mock.userTransfer(user, TREASURY, 4_000_000n, order.memo as Hex);
    mock.mode.burn = "unknown";
    const r1 = await processOfframp(order.id, {}, deps);
    expect(r1.order.status).toBe("burning");
    expect(r1.inProgress).toBe(true);
    clk.advance(61_000);
    mock.mode.burn = "success";
    const r2 = await processOfframp(order.id, {}, deps);
    expect(r2.order.status).toBe("burned");
    expect(mock.calls.burn).toBe(1);
  });
});
