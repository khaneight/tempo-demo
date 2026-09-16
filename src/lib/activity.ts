import { and, desc, eq, or } from "drizzle-orm";
import { type Address, getAbiItem, type Hex } from "viem";
import { Abis } from "viem/tempo";
import { db } from "@/db";
import { transferEvents, users, type OfframpOrder, type OnrampOrder, type TransferEvent } from "@/db/schema";
import { chain as defaultChain, type Chain, FEE_MANAGER, ZERO } from "./chain";
import { env } from "./env";
import { listOfframps } from "./offramp";
import { listOnramps } from "./onramp";

/**
 * Unified wallet activity: ledger orders (deposits / withdrawals, with their
 * fiat-side status) merged with on-chain AcmeUSD Transfer logs (sends /
 * receives / fees). On-chain logs are indexed incrementally per wallet into
 * `transfer_events` so each page load only asks the RPC for new blocks.
 */

export type ActivityKind = "deposit" | "withdrawal" | "send" | "receive" | "fee";
export type ActivityRow = {
  id: string;
  kind: ActivityKind;
  amount: bigint;
  /** Order status for deposits/withdrawals; "confirmed" for on-chain-only rows. */
  status: string;
  /** Counterparty address (treasury / peer / fee manager); null for deposits. */
  counterparty: string | null;
  memo: string | null;
  txHash: string | null;
  /** Order id when the row is backed by a ledger order. */
  orderId: string | null;
  at: Date;
};

const CHUNK = 50_000n;
/** Work budget per request: the route has a 30 s ceiling; the next poll continues from the cursor. */
const MAX_CHUNKS_PER_SYNC = 4;
/** One sync per wallet per process at a time (serverless instances poll the same wallet concurrently). */
const inFlight = new Map<string, Promise<bigint>>();
const transferEvent = getAbiItem({ abi: Abis.tip20, name: "Transfer" });

export interface LogSource {
  getBlockNumber(): Promise<bigint>;
  getTransferLogs(p: { address: Address; fromBlock: bigint; toBlock: bigint; wallet: Address }): Promise<
    { txHash: Hex; logIndex: number; blockNumber: bigint; from: Address; to: Address; amount: bigint }[]
  >;
  getBlockTimestamp(blockNumber: bigint): Promise<Date>;
}

/** viem-backed log source (two filtered queries per chunk: as sender, as recipient). */
export function viemLogSource(client: {
  getBlockNumber(): Promise<bigint>;
  getLogs(p: unknown): Promise<unknown[]>;
  getBlock(p: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}): LogSource {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    async getTransferLogs({ address, fromBlock, toBlock, wallet }) {
      const [sent, received] = await Promise.all([
        client.getLogs({ address, event: transferEvent, args: { from: wallet }, fromBlock, toBlock }),
        client.getLogs({ address, event: transferEvent, args: { to: wallet }, fromBlock, toBlock }),
      ]);
      type L = { transactionHash: Hex | null; logIndex: number | null; blockNumber: bigint | null; args: { from?: Address; to?: Address; amount?: bigint } };
      const out = new Map<string, ReturnType<LogSource["getTransferLogs"]> extends Promise<(infer R)[]> ? R : never>();
      for (const l of [...sent, ...received] as L[]) {
        if (!l.transactionHash || l.logIndex == null || l.blockNumber == null || !l.args.from || !l.args.to || l.args.amount == null) continue;
        out.set(`${l.transactionHash}:${l.logIndex}`, {
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          blockNumber: l.blockNumber,
          from: l.args.from.toLowerCase() as Address,
          to: l.args.to.toLowerCase() as Address,
          amount: l.args.amount,
        });
      }
      return [...out.values()];
    },
    async getBlockTimestamp(blockNumber) {
      const b = await client.getBlock({ blockNumber });
      return new Date(Number(b.timestamp) * 1000);
    },
  };
}

/** Copy this wallet's new Transfer logs into transfer_events; returns the block synced to (may lag `latest` if the budget ran out). */
export function syncTransfers(wallet: Address, src: LogSource, token: Address, deployBlock: bigint): Promise<bigint> {
  const key = `${token}:${wallet}`.toLowerCase();
  const running = inFlight.get(key);
  if (running) return running;
  const p = syncTransfersInner(wallet, src, token, deployBlock).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function syncTransfersInner(wallet: Address, src: LogSource, token: Address, deployBlock: bigint): Promise<bigint> {
  const [u] = await db.select({ syncedBlock: users.syncedBlock, syncToken: users.syncToken }).from(users).where(eq(users.address, wallet));
  const latest = await src.getBlockNumber();
  // A cursor from another token is meaningless here: start over from this token's deploy block.
  const cursor = u?.syncToken?.toLowerCase() === token.toLowerCase() ? u?.syncedBlock : null;
  let from = (cursor ?? deployBlock - 1n) + 1n;
  if (from > latest) return latest;
  let synced = from - 1n;
  for (let i = 0; i < MAX_CHUNKS_PER_SYNC && from <= latest; i++) {
    const to = from + CHUNK - 1n < latest ? from + CHUNK - 1n : latest;
    const logs = await src.getTransferLogs({ address: token, fromBlock: from, toBlock: to, wallet });
    if (logs.length) {
      const blocks = [...new Set(logs.map((l) => l.blockNumber))];
      const times = await Promise.all(blocks.map((b) => src.getBlockTimestamp(b)));
      const blockTimes = new Map(blocks.map((b, j) => [b, times[j]]));
      await db
        .insert(transferEvents)
        .values(logs.map((l) => ({ txHash: l.txHash, logIndex: l.logIndex, token: token.toLowerCase(), blockNumber: l.blockNumber, blockTime: blockTimes.get(l.blockNumber)!, from: l.from, to: l.to, amount: l.amount })))
        // Rows indexed before token scoping existed carry token '' — claim them on re-sync.
        .onConflictDoUpdate({ target: [transferEvents.txHash, transferEvents.logIndex], set: { token: token.toLowerCase() } });
    }
    await db.update(users).set({ syncedBlock: to, syncToken: token.toLowerCase() }).where(eq(users.address, wallet));
    synced = to;
    from = to + 1n;
  }
  return synced;
}

/** Pure merge: orders + this wallet's transfer logs -> one timeline. */
export function buildActivity(p: {
  wallet: string;
  treasury: string;
  onramps: OnrampOrder[];
  offramps: OfframpOrder[];
  events: TransferEvent[];
}): ActivityRow[] {
  const wallet = p.wallet.toLowerCase();
  const treasury = p.treasury.toLowerCase();
  const rows: ActivityRow[] = [];
  const claimed = new Set<string>(); // tx hashes already represented by an order

  for (const o of p.onramps) {
    if (o.mintTxHash) claimed.add(o.mintTxHash.toLowerCase());
    rows.push({ id: `onramp:${o.id}`, kind: "deposit", amount: o.amount, status: o.status, counterparty: null, memo: null, txHash: o.mintTxHash, orderId: o.id, at: o.completedAt ?? o.createdAt });
  }
  for (const o of p.offramps) {
    if (o.transferTxHash) claimed.add(o.transferTxHash.toLowerCase());
    rows.push({ id: `offramp:${o.id}`, kind: "withdrawal", amount: o.amount, status: o.status, counterparty: treasury, memo: null, txHash: o.transferTxHash, orderId: o.id, at: o.creditedAt ?? o.createdAt });
  }
  for (const e of p.events) {
    const hash = e.txHash.toLowerCase();
    const from = e.from.toLowerCase();
    const to = e.to.toLowerCase();
    if (from === wallet && to === FEE_MANAGER) {
      rows.push({ id: `fee:${hash}:${e.logIndex}`, kind: "fee", amount: e.amount, status: "confirmed", counterparty: FEE_MANAGER, memo: null, txHash: e.txHash, orderId: null, at: e.blockTime });
      continue;
    }
    if (claimed.has(hash)) continue; // the mint / offramp transfer is already shown as its order
    if (from === wallet && to !== wallet) {
      rows.push({ id: `send:${hash}:${e.logIndex}`, kind: "send", amount: e.amount, status: "confirmed", counterparty: to === ZERO ? "burn" : to, memo: e.memo, txHash: e.txHash, orderId: null, at: e.blockTime });
    } else if (to === wallet) {
      rows.push({ id: `receive:${hash}:${e.logIndex}`, kind: "receive", amount: e.amount, status: "confirmed", counterparty: from === ZERO ? "mint" : from, memo: e.memo, txHash: e.txHash, orderId: null, at: e.blockTime });
    }
  }
  return rows.sort((a, b) => b.at.getTime() - a.at.getTime());
}

export async function getActivity(wallet: Address, deps: { chain?: Chain; source?: LogSource } = {}): Promise<{ rows: ActivityRow[]; syncedBlock: bigint | null; syncError: boolean }> {
  const e = env();
  const ch = deps.chain ?? defaultChain();
  let syncedBlock: bigint | null = null;
  let syncError = false;
  try {
    const src = deps.source ?? viemLogSource(ch.client);
    syncedBlock = await syncTransfers(wallet, src, ch.token, e.TOKEN_DEPLOY_BLOCK);
  } catch (err) {
    // Serve what we have; the next load retries the sync.
    syncError = true;
    console.warn("[activity] sync failed:", (err as Error).message.split("\n")[0]);
  }
  const [onramps, offramps, events] = await Promise.all([
    listOnramps(wallet, ch.token, 500),
    listOfframps(wallet, ch.token, 500),
    db
      .select()
      .from(transferEvents)
      .where(and(eq(transferEvents.token, ch.token.toLowerCase()), or(eq(transferEvents.from, wallet), eq(transferEvents.to, wallet))))
      .orderBy(desc(transferEvents.blockNumber), desc(transferEvents.logIndex))
      .limit(500),
  ]);
  return { rows: buildActivity({ wallet, treasury: ch.treasury, onramps, offramps, events }), syncedBlock, syncError };
}

