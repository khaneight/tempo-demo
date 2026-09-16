import { beforeEach, describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { db } from "@/db";
import { transferEvents, users } from "@/db/schema";
import { buildActivity, syncTransfers, type LogSource } from "@/lib/activity";
import { FEE_MANAGER, ZERO } from "@/lib/chain";
import { makeUser, resetDb, TOKEN, TREASURY } from "@/test/mock-chain";
import { eq } from "drizzle-orm";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const ev = (p: { tx: number; from: string; to: string; amount: bigint; t: number; logIndex?: number }) => ({
  txHash: h(p.tx),
  logIndex: p.logIndex ?? 0,
  token: TOKEN,
  blockNumber: BigInt(p.t),
  blockTime: new Date(p.t * 1000),
  from: p.from,
  to: p.to,
  amount: p.amount,
  memo: null,
});

describe("buildActivity (pure merge)", () => {
  const me = "0x59ef6877c5b6dd640ce9e1f94931e9eab40333ff";
  const peer = "0x1111111111111111111111111111111111111111";
  const base = { id: "", userAddress: me, memo: "0x", createdBlock: 1n, lastError: null, createdAt: new Date(1000), updatedAt: new Date(1000), completedAt: null } as const;

  it("shows orders once (their tx hashes are not duplicated as raw transfers) and classifies the rest", () => {
    const rows = buildActivity({
      wallet: me,
      treasury: TREASURY,
      onramps: [{ ...base, id: "on1", amount: 25_000_000n, status: "minted", mintTxHash: h(1), completedAt: new Date(2000) } as never],
      offramps: [{ ...base, id: "off1", amount: 10_000_000n, status: "burned", transferTxHash: h(2), creditedAt: new Date(4000) } as never],
      events: [
        ev({ tx: 1, from: ZERO, to: me, amount: 25_000_000n, t: 2 }), // the mint → hidden (order shown)
        ev({ tx: 2, from: me, to: TREASURY, amount: 10_000_000n, t: 4 }), // the offramp transfer → hidden
        ev({ tx: 2, from: me, to: FEE_MANAGER, amount: 1003n, t: 4, logIndex: 3 }), // its fee → shown
        ev({ tx: 3, from: me, to: peer, amount: 1_000_000n, t: 5 }), // send
        ev({ tx: 4, from: peer, to: me, amount: 500_000n, t: 6 }), // receive
        ev({ tx: 5, from: ZERO, to: me, amount: 49n, t: 7 }), // mint outside the ledger → receive from "mint"
      ],
    });
    expect(rows.map((r) => [r.kind, r.amount, r.counterparty])).toEqual([
      ["receive", 49n, "mint"],
      ["receive", 500_000n, peer],
      ["send", 1_000_000n, peer],
      ["withdrawal", 10_000_000n, TREASURY],
      ["fee", 1003n, FEE_MANAGER],
      ["deposit", 25_000_000n, null],
    ]);
    expect(rows.find((r) => r.kind === "withdrawal")?.status).toBe("burned");
    expect(rows.find((r) => r.kind === "deposit")?.orderId).toBe("on1");
  });
});

describe("syncTransfers (incremental index)", () => {
  beforeEach(resetDb);

  it("indexes from the deploy block in chunks, records the synced block, and only asks for new blocks next time", async () => {
    const me = (await makeUser("cc")) as Address;
    const calls: [bigint, bigint][] = [];
    const src: LogSource = {
      getBlockNumber: async () => 120_000n,
      async getTransferLogs({ fromBlock, toBlock, wallet }) {
        calls.push([fromBlock, toBlock]);
        return fromBlock <= 60_000n && toBlock >= 60_000n
          ? [{ txHash: h(9), logIndex: 0, blockNumber: 60_000n, from: ZERO, to: wallet, amount: 5n }]
          : [];
      },
      getBlockTimestamp: async (b) => new Date(Number(b) * 1000),
    };
    const synced = await syncTransfers(me, src, TOKEN, 10_000n);
    expect(synced).toBe(120_000n);
    expect(calls).toEqual([
      [10_000n, 59_999n],
      [60_000n, 109_999n],
      [110_000n, 120_000n],
    ]);
    const rows = await db.select().from(transferEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].to).toBe(me);
    expect((await db.select().from(users).where(eq(users.address, me)))[0].syncedBlock).toBe(120_000n);

    // Second sync: only the new range.
    calls.length = 0;
    src.getBlockNumber = async () => 120_050n;
    await syncTransfers(me, src, TOKEN, 10_000n);
    expect(calls).toEqual([[120_001n, 120_050n]]);
    // Re-inserting the same log is a no-op (primary key on tx hash + log index).
    calls.length = 0;
    await db.update(users).set({ syncedBlock: 10_000n }).where(eq(users.address, me));
    await syncTransfers(me, src, TOKEN, 10_000n);
    expect(await db.select().from(transferEvents)).toHaveLength(1);
  });
});
