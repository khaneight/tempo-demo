/**
 * Ops helper: where is every AcmeUSD? Prints supply, treasury, Fee AMM holdings,
 * optional user balances, and decodes a tx's Tempo fields (nonceKey, feeToken).
 *
 *   pnpm exec tsx scripts/inspect.ts [address ...] [--tx 0x...]
 */
import "dotenv/config";
import { formatUnits } from "viem";
import { Abis, createClient, http } from "viem/tempo";

const FEE_MANAGER = "0xfeec000000000000000000000000000000000000" as const;

async function main() {
  const c = createClient({ testnet: true, transport: http(process.env.TEMPO_RPC_URL) });
  const token = process.env.ACME_USD_ADDRESS as `0x${string}`;
  const treasury = (process.env.NEXT_PUBLIC_TREASURY_ADDRESS ?? "") as `0x${string}`;
  const bal = (a: `0x${string}`) => c.readContract({ address: token, abi: Abis.tip20, functionName: "balanceOf", args: [a] });
  const f = (v: bigint) => formatUnits(v, 6);

  const args = process.argv.slice(2);
  const txIdx = args.indexOf("--tx");
  const txHash = txIdx >= 0 ? (args[txIdx + 1] as `0x${string}`) : undefined;
  const addrs = args.filter((a, i) => a.startsWith("0x") && i !== txIdx + 1) as `0x${string}`[];

  console.log("token:", token);
  console.log("totalSupply:", f(await c.readContract({ address: token, abi: Abis.tip20, functionName: "totalSupply" })));
  if (treasury) console.log("treasury:", f(await bal(treasury)));
  console.log("fee AMM (0xfeec…) holds:", f(await bal(FEE_MANAGER)), "<- fees paid in AcmeUSD accumulate here");
  for (const a of addrs) console.log(a, f(await bal(a)));
  if (txHash) {
    const tx = (await c.getTransaction({ hash: txHash })) as unknown as Record<string, unknown>;
    console.log("tx", txHash, { type: tx.type, nonceKey: tx.nonceKey, nonce: tx.nonce, feeToken: tx.feeToken, from: tx.from });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
