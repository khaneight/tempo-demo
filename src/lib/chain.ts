import { type Address, type Hex, getAbiItem, parseEventLogs } from "viem";
import { Abis, Account, createClient, http } from "viem/tempo";
import { env } from "./env";

/**
 * The single seam between the ledger and Tempo. Everything the state machines
 * need from the chain goes through this interface so it can be mocked in tests
 * and fault-injected (CHAOS) in manual testing.
 */

export type TxOutcome =
  | { kind: "success"; txHash: Hex; blockNumber: bigint }
  /** Included on-chain but reverted. The nonce for this attempt IS consumed. */
  | { kind: "reverted"; txHash: Hex | null; reason: string }
  /** Never entered the mempool. `nonceTooLow` means a previous send with the same key landed. */
  | { kind: "rejected"; reason: string; nonceTooLow: boolean }
  /** We cannot tell whether it landed (timeout / network). Recover by memo before retrying. */
  | { kind: "unknown"; reason: string };

export type MemoTransfer = {
  txHash: Hex;
  blockNumber: bigint;
  from: Address;
  to: Address;
  amount: bigint;
  memo: Hex;
};

export interface Chain {
  readonly token: Address;
  readonly treasury: Address;
  /** Underlying read client (log queries for the activity index). */
  readonly client: Pick<ChainClient, "getBlockNumber" | "getLogs" | "getBlock">;
  mintWithMemo(p: { to: Address; amount: bigint; memo: Hex; nonceKey: bigint }): Promise<TxOutcome>;
  burnWithMemo(p: { amount: bigint; memo: Hex; nonceKey: bigint }): Promise<TxOutcome>;
  /** All AcmeUSD `TransferWithMemo` logs carrying this memo since `fromBlock`. */
  findTransfersByMemo(p: { memo: Hex; fromBlock: bigint }): Promise<MemoTransfer[]>;
  /** Receipt status + AcmeUSD `TransferWithMemo` logs of a tx; null if the tx is unknown. */
  getReceiptTransfers(txHash: Hex): Promise<{ status: "success" | "reverted"; transfers: MemoTransfer[] } | null>;
  /** Current nonce under a 2D nonce key for the issuer (0 = never used). */
  getNonce(nonceKey: bigint): Promise<bigint>;
  getBlockNumber(): Promise<bigint>;
  balanceOf(account: Address): Promise<bigint>;
  totalSupply(): Promise<bigint>;
}

export const ZERO = "0x0000000000000000000000000000000000000000" as const;
/** FeeManager / Fee AMM precompile. Fees paid in AcmeUSD end up held here (ACME is the LP). */
export const FEE_MANAGER = "0xfeec000000000000000000000000000000000000" as const;
const transferWithMemoEvent = getAbiItem({ abi: Abis.tip20, name: "TransferWithMemo" });

export function classifyError(err: unknown): TxOutcome {
  const e = err as { name?: string; message?: string; shortMessage?: string; details?: string };
  // `details` can echo the RPC URL and request payload; classify on it but never store it.
  const text = [e?.name, e?.shortMessage, e?.details, e?.message].filter(Boolean).join(" | ");
  const reason =
    [e?.name, e?.shortMessage ?? e?.message]
      .filter(Boolean)
      .join(": ")
      .replace(/https?:\/\/\S+/g, "[url]")
      .split("\n")[0]
      .slice(0, 200) || "unknown error";
  const name = e?.name ?? "";
  // "nonce too low" = a tx with this (key, nonce) was already INCLUDED → recover it by memo.
  if (/NonceTooLow/i.test(name) || /nonce too low|nonce.*(already|used)/i.test(text)) {
    return { kind: "rejected", reason, nonceTooLow: true };
  }
  // "already known / imported" = the identical tx is PENDING in the mempool, not included yet.
  // Treat as unknown so we wait out the in-flight window and then either find it or re-send the same key.
  if (/already known|already imported|already in (the )?(mempool|pool)|replacement transaction/i.test(text)) {
    return { kind: "unknown", reason };
  }
  if (
    /HttpRequestError|TimeoutError|WaitForTransactionReceiptTimeout|ReceiptNotFound|SocketClosed|WebSocketRequest/i.test(name) ||
    /timeout|timed out|fetch failed|ECONN|socket hang up|network error/i.test(text)
  ) {
    return { kind: "unknown", reason };
  }
  return { kind: "rejected", reason, nonceTooLow: false };
}

/** Type-only: the concrete Tempo-typed client (keeps `nonceKey`/`feeToken` in write params). Never called. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const tempoClientFactory = () => createClient({ account: Account.fromSecp256k1(`0x${"11".repeat(32)}`), testnet: true, transport: http() });
type TempoClient = ReturnType<typeof tempoClientFactory>;

/** The slice of the viem Tempo client the adapter uses (narrow so tests can fake it). */
export type ChainClient = Pick<
  TempoClient,
  "writeContractSync" | "getLogs" | "getTransactionReceipt" | "getBlockNumber" | "getBlock" | "readContract" | "nonce"
>;

export type CreateChainOptions = {
  client?: ChainClient;
  token?: Address;
  treasury?: Address;
  feeToken?: Address;
  chaos?: string;
};

export function createChain(opts: CreateChainOptions = {}): Chain {
  const e = opts.client ? undefined : env();
  const account = e ? Account.fromSecp256k1(e.ISSUER_PRIVATE_KEY) : undefined;
  const client: ChainClient = opts.client ?? createClient({ account: account!, testnet: true, transport: http(e!.TEMPO_RPC_URL) });
  if (opts.client && !opts.treasury) throw new Error("createChain: `treasury` is required when injecting a client");
  const treasury = (opts.treasury ?? account!.address).toLowerCase() as Address;
  const token = opts.token ?? e!.ACME_USD_ADDRESS;
  const feeToken = opts.feeToken ?? e!.ISSUER_FEE_TOKEN;
  const chaos = opts.chaos ?? e?.CHAOS;

  function outcomeFromReceipt(receipt: { status: string; transactionHash: Hex; blockNumber: bigint }): TxOutcome {
    if (receipt.status === "success") {
      return { kind: "success", txHash: receipt.transactionHash, blockNumber: receipt.blockNumber };
    }
    if (receipt.status === "reverted") {
      return { kind: "reverted", txHash: receipt.transactionHash, reason: "transaction reverted on-chain" };
    }
    return { kind: "unknown", reason: `receipt status ${receipt.status}` };
  }

  function toMemoTransfer(log: {
    transactionHash: Hex | null;
    blockNumber: bigint | null;
    args: { from?: Address; to?: Address; amount?: bigint; memo?: Hex };
  }): MemoTransfer | null {
    const { from, to, amount, memo } = log.args;
    if (!log.transactionHash || log.blockNumber == null || !from || !to || amount == null || !memo) return null;
    return {
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      from: from.toLowerCase() as Address,
      to: to.toLowerCase() as Address,
      amount,
      memo: memo.toLowerCase() as Hex,
    };
  }

  return {
    token,
    treasury,
    client,

    async mintWithMemo({ to, amount, memo, nonceKey }) {
      if (chaos === "mint_revert") return { kind: "reverted", txHash: null, reason: "CHAOS=mint_revert" };
      try {
        const receipt = await client.writeContractSync({
          address: token,
          abi: Abis.tip20,
          functionName: "mintWithMemo",
          args: [to, amount, memo],
          nonceKey,
          nonce: 0,
          feeToken,
          throwOnReceiptRevert: false,
        });
        if (chaos === "mint_unknown") return { kind: "unknown", reason: "CHAOS=mint_unknown (tx was actually sent)" };
        return outcomeFromReceipt(receipt);
      } catch (err) {
        return classifyError(err);
      }
    },

    async burnWithMemo({ amount, memo, nonceKey }) {
      try {
        const receipt = await client.writeContractSync({
          address: token,
          abi: Abis.tip20,
          functionName: "burnWithMemo",
          args: [amount, memo],
          nonceKey,
          nonce: 0,
          feeToken,
          throwOnReceiptRevert: false,
        });
        if (chaos === "burn_unknown") return { kind: "unknown", reason: "CHAOS=burn_unknown (tx was actually sent)" };
        return outcomeFromReceipt(receipt);
      } catch (err) {
        return classifyError(err);
      }
    },

    async findTransfersByMemo({ memo, fromBlock }) {
      const logs = await client.getLogs({
        address: token,
        event: transferWithMemoEvent,
        args: { memo },
        fromBlock,
        toBlock: "latest",
      });
      return logs.map(toMemoTransfer).filter((t): t is MemoTransfer => t !== null);
    },

    async getReceiptTransfers(txHash) {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: txHash });
      } catch (err) {
        if ((err as { name?: string })?.name === "TransactionReceiptNotFoundError") return null;
        throw err;
      }
      const logs = parseEventLogs({ abi: Abis.tip20, eventName: "TransferWithMemo", logs: receipt.logs }).filter(
        (l) => l.address.toLowerCase() === token,
      );
      return {
        status: receipt.status === "success" ? "success" : "reverted",
        transfers: logs.map(toMemoTransfer).filter((t): t is MemoTransfer => t !== null),
      };
    },

    getNonce: (nonceKey) => client.nonce.getNonce({ account: treasury, nonceKey }),
    getBlockNumber: () => client.getBlockNumber(),
    balanceOf: (a) => client.readContract({ address: token, abi: Abis.tip20, functionName: "balanceOf", args: [a] }),
    totalSupply: () => client.readContract({ address: token, abi: Abis.tip20, functionName: "totalSupply" }),
  };
}

let singleton: Chain | undefined;
/** Process-wide chain adapter (serverless functions reuse it across warm invocations). */
export function chain(): Chain {
  if (!singleton) singleton = createChain();
  return singleton;
}
