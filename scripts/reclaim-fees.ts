/**
 * Ops: pull AcmeUSD out of the Fee AMM (where fees paid in AcmeUSD accumulate)
 * and burn it. ACME pays the validator token side (pathUSD/AlphaUSD) via
 * `rebalanceSwap`, receives AcmeUSD, and burns it from treasury.
 *
 *   pnpm exec tsx scripts/reclaim-fees.ts <amount base units | "all">
 *
 * Uses nonceKey 0 (protocol nonce) — never run concurrently with app traffic
 * that could use key 0 (the app never does).
 */
import "dotenv/config";
import { formatUnits, type Address, type Hex } from "viem";
import { Abis, Account, createClient, http } from "viem/tempo";

const PATH_USD = "0x20c0000000000000000000000000000000000000" as const;
const ALPHA_USD = "0x20c0000000000000000000000000000000000001" as const;

async function main() {
  const account = Account.fromSecp256k1(process.env.ISSUER_PRIVATE_KEY as Hex);
  const client = createClient({ account, testnet: true, transport: http(process.env.TEMPO_RPC_URL) });
  const token = process.env.ACME_USD_ADDRESS as Address;
  const want = process.argv[2] ?? "all";

  let reclaimed = 0n;
  for (const validatorToken of [ALPHA_USD, PATH_USD] as const) {
    const pool = await client.amm.getPool({ userToken: token, validatorToken });
    const available = pool.reserveUserToken;
    if (available === 0n) continue;
    const target = want === "all" ? available : BigInt(want) - reclaimed;
    const amountOut = target < available ? target : available;
    if (amountOut <= 0n) break;
    console.log(`pool ${validatorToken.slice(0, 10)}…: reserveUser=${formatUnits(available, 6)} -> rebalanceSwap out ${formatUnits(amountOut, 6)}`);
    const r = await client.amm.rebalanceSwapSync({ userToken: token, validatorToken, amountOut, to: account.address, feeToken: PATH_USD });
    console.log("  tx", r.receipt.transactionHash, r.receipt.status);
    reclaimed += amountOut;
  }
  if (reclaimed === 0n) return console.log("nothing to reclaim");
  const bal = await client.readContract({ address: token, abi: Abis.tip20, functionName: "balanceOf", args: [account.address] });
  const burn = reclaimed < bal ? reclaimed : bal;
  const b = await client.token.burnSync({ token, amount: burn, feeToken: PATH_USD });
  console.log(`burned ${formatUnits(burn, 6)} AcmeUSD`, b.receipt.transactionHash);
  console.log("totalSupply now:", formatUnits(await client.readContract({ address: token, abi: Abis.tip20, functionName: "totalSupply" }), 6));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
