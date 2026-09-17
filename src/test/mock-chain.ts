import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { db } from "@/db";
import { users } from "@/db/schema";
import { type Chain, type MemoTransfer, type TxOutcome, ZERO } from "@/lib/chain";

export const TOKEN = "0x20c0000000000000000000000000000000000abc" as Address;
export const TREASURY = "0x5909e7e9248d391d25ad018ab439c54b5f208a46" as Address;

type Mode = "success" | "revert" | "unknown" | "reject" | "hang";

/**
 * In-memory Tempo. Enforces the one protocol rule the design leans on:
 * a (nonceKey, nonce 0) pair can be consumed at most once. Records every
 * landed op as a TransferWithMemo so memo recovery behaves like the real chain.
 */
export function mockChain() {
  const transfers: MemoTransfer[] = [];
  const nonces = new Map<bigint, bigint>();
  let block = 1_000n;
  const calls = { mint: 0, burn: 0 };
  const mode: { mint: Mode; burn: Mode } = { mint: "success", burn: "success" };
  const receipts = new Map<Hex, { status: "success" | "reverted"; transfers: MemoTransfer[] }>();
  /** Simulated RPC lag: getNonce reports 0 even after consumption; memo lookups miss N times. */
  const lag = { nonce: false, memoMisses: 0 };

  const hash = () => `0x${randomBytes(32).toString("hex")}` as Hex;

  function land(from: Address, to: Address, amount: bigint, memo: Hex): MemoTransfer {
    const t = { txHash: hash(), blockNumber: ++block, from, to, amount, memo: memo.toLowerCase() as Hex };
    transfers.push(t);
    receipts.set(t.txHash, { status: "success", transfers: [t] });
    return t;
  }

  function send(kind: "mint" | "burn", nonceKey: bigint, from: Address, to: Address, amount: bigint, memo: Hex): TxOutcome {
    calls[kind]++;
    const m = mode[kind];
    if (m === "reject") return { kind: "rejected", reason: "insufficient funds for fee", nonceTooLow: false };
    if ((nonces.get(nonceKey) ?? 0n) > 0n) return { kind: "rejected", reason: "nonce too low", nonceTooLow: true };
    nonces.set(nonceKey, 1n);
    if (m === "revert") return { kind: "reverted", txHash: hash(), reason: "SupplyCapExceeded" };
    if (m === "hang") return { kind: "unknown", reason: "timeout (never broadcast)" };
    const t = land(from, to, amount, memo);
    if (m === "unknown") return { kind: "unknown", reason: "timeout (but landed)" };
    return { kind: "success", txHash: t.txHash, blockNumber: t.blockNumber };
  }

  const chain: Chain = {
    token: TOKEN,
    treasury: TREASURY,
    client: {
      getBlockNumber: async () => block,
      getLogs: (async () => []) as never,
      getBlock: (async () => ({ timestamp: 0n })) as never,
    },
    async mintWithMemo({ to, amount, memo, nonceKey }) {
      return send("mint", nonceKey, ZERO, to.toLowerCase() as Address, amount, memo);
    },
    async burnWithMemo({ amount, memo, nonceKey }) {
      return send("burn", nonceKey, TREASURY, ZERO, amount, memo);
    },
    async findTransfersByMemo({ memo, fromBlock }) {
      if (lag.memoMisses > 0) {
        lag.memoMisses--;
        return [];
      }
      return transfers.filter((t) => t.memo === memo.toLowerCase() && t.blockNumber >= fromBlock);
    },
    async getReceiptTransfers(txHash) {
      return receipts.get(txHash) ?? null;
    },
    async getNonce(nonceKey) {
      if (lag.nonce) return 0n;
      return nonces.get(nonceKey) ?? 0n;
    },
    async getBlockNumber() {
      return block;
    },
    async balanceOf() {
      return 0n;
    },
    async totalSupply() {
      return 0n;
    },
  };

  return {
    chain,
    calls,
    mode,
    lag,
    transfers,
    /** Simulate a user's wallet transfer to treasury (or anywhere). */
    userTransfer(from: Address, to: Address, amount: bigint, memo: Hex) {
      return land(from.toLowerCase() as Address, to.toLowerCase() as Address, amount, memo);
    },
    revertedReceipt() {
      const h = hash();
      receipts.set(h, { status: "reverted", transfers: [] });
      return h;
    },
  };
}

export async function resetDb() {
  await db.execute(sql`truncate table onramp_orders, offramp_orders, transfer_events, users, identities, kv restart identity cascade`);
}

export async function makeUser(seed = "aa"): Promise<Address> {
  const address = `0x${seed.repeat(20).slice(0, 40)}` as Address;
  await db.insert(users).values({ address, credentialId: `cred-${seed}-${Date.now()}` }).onConflictDoNothing();
  return address;
}

/** Controllable clock for in-progress window tests. */
export function clock(start = Date.now()) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}
