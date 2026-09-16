import { describe, expect, it, vi } from "vitest";
import type { Address, Hex } from "viem";
import { encodeEventTopics, encodeAbiParameters } from "viem";
import { Abis } from "viem/tempo";
import { createChain, type ChainClient, ZERO } from "@/lib/chain";

/**
 * The chain adapter is the only code that talks to Tempo for mint/burn.
 * These tests pin down exactly what it sends (per-order nonce key, nonce 0,
 * issuer fee token, memo'd functions) and how every RPC outcome maps to a
 * TxOutcome — the contract the state machines rely on.
 */

const TOKEN = "0x20c0000000000000000000000000000000000abc" as Address;
const TREASURY = "0x5909e7e9248d391d25ad018ab439c54b5f208a46" as Address;
const PATH_USD = "0x20c0000000000000000000000000000000000000" as Address;
const USER = "0x59ef6877c5b6dd640ce9e1f94931e9eab40333ff" as Address;
const MEMO = ("0x" + "1".repeat(64)) as Hex;
const HASH = ("0x" + "a".repeat(64)) as Hex;

function receipt(status: "success" | "reverted" | "pending", logs: unknown[] = []) {
  return { status, transactionHash: HASH, blockNumber: 500n, logs };
}

/** A real TransferWithMemo log as viem would return it from eth_getTransactionReceipt. */
function transferWithMemoLog(p: { address?: Address; from: Address; to: Address; amount: bigint; memo: Hex }) {
  const topics = encodeEventTopics({
    abi: Abis.tip20,
    eventName: "TransferWithMemo",
    args: { from: p.from, to: p.to, memo: p.memo },
  });
  return {
    address: p.address ?? TOKEN,
    topics,
    data: encodeAbiParameters([{ type: "uint256" }], [p.amount]),
    transactionHash: HASH,
    blockNumber: 500n,
    logIndex: 0,
    blockHash: HASH,
    transactionIndex: 0,
    removed: false,
  };
}

function fakeClient(over: Partial<ChainClient> = {}): ChainClient & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {};
  const rec =
    (name: string, impl: (...a: unknown[]) => unknown) =>
    (...a: unknown[]) => {
      (calls[name] ??= []).push(a);
      return impl(...a);
    };
  const o = over as Record<string, (...a: unknown[]) => unknown>;
  return {
    calls,
    writeContractSync: rec("writeContractSync", o.writeContractSync ?? (async () => receipt("success"))) as never,
    getLogs: rec("getLogs", o.getLogs ?? (async () => [])) as never,
    getTransactionReceipt: rec("getTransactionReceipt", o.getTransactionReceipt ?? (async () => receipt("success"))) as never,
    getBlockNumber: rec("getBlockNumber", o.getBlockNumber ?? (async () => 123n)) as never,
    getBlock: rec("getBlock", o.getBlock ?? (async () => ({ timestamp: 1_700_000_000n }))) as never,
    readContract: rec("readContract", o.readContract ?? (async () => 0n)) as never,
    nonce: { getNonce: rec("getNonce", async () => 0n) as never },
  } as never;
}

const mk = (client: ChainClient, chaos?: string) => createChain({ client, token: TOKEN, treasury: TREASURY, feeToken: PATH_USD, chaos });

describe("chain adapter — what mint/burn actually send", () => {
  it("mintWithMemo sends mintWithMemo(to, amount, memo) under the order's nonce key with nonce 0 and the issuer fee token", async () => {
    const c = fakeClient();
    const chain = mk(c);
    const out = await chain.mintWithMemo({ to: USER, amount: 25_000_000n, memo: MEMO, nonceKey: 777n });
    expect(out).toEqual({ kind: "success", txHash: HASH, blockNumber: 500n });
    const [args] = c.calls.writeContractSync[0] as [Record<string, unknown>];
    expect(args.address).toBe(TOKEN);
    expect(args.functionName).toBe("mintWithMemo");
    expect(args.args).toEqual([USER, 25_000_000n, MEMO]);
    expect(args.nonceKey).toBe(777n);
    expect(args.nonce).toBe(0);
    expect(args.feeToken).toBe(PATH_USD);
    expect(args.throwOnReceiptRevert).toBe(false); // we branch on receipt.status ourselves
  });

  it("burnWithMemo sends burnWithMemo(amount, memo) with the same guarantees", async () => {
    const c = fakeClient();
    const out = await mk(c).burnWithMemo({ amount: 10_000_000n, memo: MEMO, nonceKey: 778n });
    expect(out.kind).toBe("success");
    const [args] = c.calls.writeContractSync[0] as [Record<string, unknown>];
    expect(args.functionName).toBe("burnWithMemo");
    expect(args.args).toEqual([10_000_000n, MEMO]);
    expect(args.nonceKey).toBe(778n);
    expect(args.nonce).toBe(0);
  });

  it("a reverted receipt is reported as reverted, never as success or thrown", async () => {
    const c = fakeClient({ writeContractSync: (async () => receipt("reverted")) as never });
    const out = await mk(c).mintWithMemo({ to: USER, amount: 1n, memo: MEMO, nonceKey: 1n });
    expect(out).toMatchObject({ kind: "reverted", txHash: HASH });
  });

  it("a receipt that is neither success nor reverted is unknown (never assumed minted)", async () => {
    const c = fakeClient({ writeContractSync: (async () => receipt("pending")) as never });
    const out = await mk(c).mintWithMemo({ to: USER, amount: 1n, memo: MEMO, nonceKey: 1n });
    expect(out.kind).toBe("unknown");
  });

  it("maps RPC errors: nonce too low -> rejected+nonceTooLow; transport failures -> unknown; others -> rejected", async () => {
    const boom = (msg: string, name = "Error") => fakeClient({ writeContractSync: (async () => Promise.reject(Object.assign(new Error(msg), { name }))) as never });
    expect(await mk(boom("nonce too low: next nonce 1, tx nonce 0")).mintWithMemo({ to: USER, amount: 1n, memo: MEMO, nonceKey: 1n })).toMatchObject({ kind: "rejected", nonceTooLow: true });
    expect(await mk(boom("The request took too long to respond.", "TimeoutError")).mintWithMemo({ to: USER, amount: 1n, memo: MEMO, nonceKey: 1n })).toMatchObject({ kind: "unknown" });
    expect(await mk(boom("fetch failed", "HttpRequestError")).burnWithMemo({ amount: 1n, memo: MEMO, nonceKey: 1n })).toMatchObject({ kind: "unknown" });
    expect(await mk(boom("insufficient funds for fee")).mintWithMemo({ to: USER, amount: 1n, memo: MEMO, nonceKey: 1n })).toMatchObject({ kind: "rejected", nonceTooLow: false });
  });

  it("distinguishes 'included' (nonce too low) from 'pending' (already known) and from contract reverts", async () => {
    const boom = (msg: string, name = "Error", details?: string) =>
      fakeClient({ writeContractSync: (async () => Promise.reject(Object.assign(new Error(msg), { name, details }))) as never });
    const send = (c: ChainClient) => mk(c).mintWithMemo({ to: USER, amount: 1n, memo: MEMO, nonceKey: 1n });
    // viem wraps node errors: the name carries the class, the phrase only lives in `details`
    expect(await send(boom("Nonce provided for the transaction is lower than the current nonce of the account.", "NonceTooLowError", "nonce too low"))).toMatchObject({ kind: "rejected", nonceTooLow: true });
    // identical tx still in the mempool → NOT landed; wait for the window and re-check
    expect(await send(boom("already known"))).toMatchObject({ kind: "unknown" });
    expect(await send(boom("replacement transaction underpriced"))).toMatchObject({ kind: "unknown" });
    // a contract revert whose reason happens to mention the network is still a rejection
    expect(await send(boom('execution reverted: "network policy forbids"', "ContractFunctionExecutionError"))).toMatchObject({ kind: "rejected", nonceTooLow: false });
  });

  it("refuses an injected client without an explicit treasury", () => {
    expect(() => createChain({ client: fakeClient(), token: TOKEN })).toThrow(/treasury/);
  });

  it("CHAOS=mint_revert never sends; CHAOS=mint_unknown sends but hides the result", async () => {
    const c = fakeClient();
    expect(await mk(c, "mint_revert").mintWithMemo({ to: USER, amount: 1n, memo: MEMO, nonceKey: 1n })).toMatchObject({ kind: "reverted", txHash: null });
    expect(c.calls.writeContractSync).toBeUndefined();
    const out = await mk(c, "mint_unknown").mintWithMemo({ to: USER, amount: 1n, memo: MEMO, nonceKey: 1n });
    expect(out.kind).toBe("unknown");
    expect(c.calls.writeContractSync).toHaveLength(1);
  });
});

describe("chain adapter — reading the chain back", () => {
  it("findTransfersByMemo queries TransferWithMemo on the token filtered by memo from the order's block, and normalizes addresses", async () => {
    const c = fakeClient({
      getLogs: (async () => [
        { transactionHash: HASH, blockNumber: 501n, args: { from: ZERO, to: USER.toUpperCase().replace("0X", "0x"), amount: 5n, memo: MEMO.toUpperCase().replace("0X", "0x") } },
        { transactionHash: null, blockNumber: 502n, args: { from: ZERO, to: USER, amount: 5n, memo: MEMO } }, // pending log: dropped
      ]) as never,
    });
    const chain = mk(c);
    const res = await chain.findTransfersByMemo({ memo: MEMO, fromBlock: 400n });
    const [q] = c.calls.getLogs[0] as [Record<string, unknown>];
    expect(q.address).toBe(TOKEN);
    expect((q.event as { name: string }).name).toBe("TransferWithMemo");
    expect(q.args).toEqual({ memo: MEMO });
    expect(q.fromBlock).toBe(400n);
    expect(res).toEqual([{ txHash: HASH, blockNumber: 501n, from: ZERO, to: USER, amount: 5n, memo: MEMO }]);
  });

  it("getReceiptTransfers decodes only AcmeUSD TransferWithMemo logs and ignores other tokens' logs in the same tx", async () => {
    const other = "0x20c0000000000000000000000000000000000001" as Address;
    const c = fakeClient({
      getTransactionReceipt: (async () =>
        receipt("success", [
          transferWithMemoLog({ from: USER, to: TREASURY, amount: 10_000_000n, memo: MEMO }),
          transferWithMemoLog({ address: other, from: USER, to: TREASURY, amount: 999n, memo: MEMO }),
        ])) as never,
    });
    const res = await mk(c).getReceiptTransfers(HASH);
    expect(res?.status).toBe("success");
    expect(res?.transfers).toEqual([{ txHash: HASH, blockNumber: 500n, from: USER, to: TREASURY, amount: 10_000_000n, memo: MEMO }]);
  });

  it("getReceiptTransfers reports reverted receipts and returns null for unknown hashes", async () => {
    const rev = fakeClient({ getTransactionReceipt: (async () => receipt("reverted", [])) as never });
    expect((await mk(rev).getReceiptTransfers(HASH))?.status).toBe("reverted");
    const missing = fakeClient({ getTransactionReceipt: (async () => Promise.reject(Object.assign(new Error("not found"), { name: "TransactionReceiptNotFoundError" }))) as never });
    expect(await mk(missing).getReceiptTransfers(HASH)).toBeNull();
    const broken = fakeClient({ getTransactionReceipt: (async () => Promise.reject(new Error("boom"))) as never });
    await expect(mk(broken).getReceiptTransfers(HASH)).rejects.toThrow("boom");
  });

  it("getNonce asks for the issuer's nonce under the given key; balances/supply read the TIP-20 directly", async () => {
    const c = fakeClient({ readContract: vi.fn(async (p: { functionName: string }) => (p.functionName === "totalSupply" ? 15_000_000n : 7n)) as never });
    const chain = mk(c);
    await chain.getNonce(42n);
    expect(c.calls.getNonce[0][0]).toEqual({ account: TREASURY, nonceKey: 42n });
    expect(await chain.balanceOf(USER)).toBe(7n);
    expect(await chain.totalSupply()).toBe(15_000_000n);
    expect(await chain.getBlockNumber()).toBe(123n);
  });
});
