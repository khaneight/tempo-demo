/**
 * One-time ACME setup on Tempo testnet (Moderato). Idempotent-ish: re-running
 * with ACME_USD_ADDRESS set skips creation and only tops up / verifies.
 *
 *   pnpm setup:token
 *
 * Uses nonceKey 0 (the protocol nonce) — app traffic never does.
 */
import "dotenv/config";
import { parseEventLogs, parseUnits, formatUnits, type Address, type Hex } from "viem";
import { Abis, Account, createClient, http } from "viem/tempo";

const PATH_USD = "0x20c0000000000000000000000000000000000000" as const;
const ALPHA_USD = "0x20c0000000000000000000000000000000000001" as const;
const AMM_SEED = parseUnits("1000", 6); // validator-token liquidity per pool

async function main() {
  const pk = process.env.ISSUER_PRIVATE_KEY as Hex;
  if (!pk) throw new Error("ISSUER_PRIVATE_KEY missing");
  const account = Account.fromSecp256k1(pk);
  const client = createClient({
    account,
    testnet: true,
    transport: http(process.env.TEMPO_RPC_URL ?? "https://rpc.moderato.tempo.xyz"),
  });
  const me = account.address;
  console.log("issuer/treasury:", me);
  const bal = (t: Address, a: Address = me) =>
    client.readContract({ address: t, abi: Abis.tip20, functionName: "balanceOf", args: [a] });

  // 1. Fund with testnet stablecoins (issuer pays fees in pathUSD).
  const pathBal = await bal(PATH_USD);
  if (pathBal < parseUnits("100", 6)) {
    console.log("funding from faucet…");
    try {
      await client.faucet.fundSync({ account: me });
    } catch (err) {
      console.log("rpc faucet failed, trying REST:", (err as Error).message.slice(0, 120));
      const res = await fetch("https://tempo.xyz/developers/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: me.toLowerCase() }),
      });
      console.log("faucet REST:", res.status, (await res.text()).slice(0, 200));
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  for (const [name, t] of [
    ["pathUSD", PATH_USD],
    ["AlphaUSD", ALPHA_USD],
  ] as const) {
    console.log(`${name} balance:`, formatUnits(await bal(t), 6));
  }

  // 2. Create AcmeUSD (or reuse).
  let token = (process.env.ACME_USD_ADDRESS || "") as Address;
  let deployBlock = BigInt(process.env.TOKEN_DEPLOY_BLOCK || 0);
  if (!token) {
    console.log("creating AcmeUSD…");
    const created = await client.token.createSync({
      name: "Acme USD",
      symbol: "AcmeUSD",
      currency: "USD",
      feeToken: PATH_USD,
    });
    token = created.token;
    deployBlock = created.receipt.blockNumber;
    console.log("created", token, "at block", deployBlock, "tx", created.receipt.transactionHash);
  } else {
    console.log("reusing token", token);
  }
  const meta = await client.token.getMetadata({ token });
  console.log("metadata:", meta.name, meta.symbol, "decimals", meta.decimals, "supply", meta.totalSupply);

  // 3. Issuer role for the treasury key.
  const hasIssuer = await client.token.hasRole({ token, role: "issuer", account: me });
  if (!hasIssuer) {
    console.log("granting issuer role…");
    await client.token.grantRolesSync({ token, to: me, roles: ["issuer"], feeToken: PATH_USD });
  }
  console.log("issuer role:", await client.token.hasRole({ token, role: "issuer", account: me }));

  // 4. Fee AMM liquidity so AcmeUSD can pay fees (validators take AlphaUSD / pathUSD on Moderato).
  for (const [name, validatorToken] of [
    ["AlphaUSD", ALPHA_USD],
    ["pathUSD", PATH_USD],
  ] as const) {
    const pool = await client.amm.getPool({ userToken: token, validatorToken });
    if (pool.reserveValidatorToken < AMM_SEED / 2n) {
      console.log(`seeding fee AMM AcmeUSD -> ${name}…`);
      await client.amm.mintSync({
        userTokenAddress: token,
        validatorTokenAddress: validatorToken,
        validatorTokenAmount: AMM_SEED,
        to: me,
        feeToken: PATH_USD,
      });
    }
    const after = await client.amm.getPool({ userToken: token, validatorToken });
    console.log(`pool AcmeUSD->${name}: reserveValidator=${formatUnits(after.reserveValidatorToken, 6)} reserveUser=${formatUnits(after.reserveUserToken, 6)}`);
  }

  // 5. Smoke test: mint 1.00 to treasury with a memo, inspect which events carry the memo, burn it back.
  const memo = ("0x" + "ab".repeat(32)) as Hex;
  const mint = await client.writeContractSync({
    address: token,
    abi: Abis.tip20,
    functionName: "mintWithMemo",
    args: [me, 1_000_000n, memo],
    feeToken: PATH_USD,
  });
  console.log("smoke mint:", mint.status, mint.transactionHash);
  for (const l of parseEventLogs({ abi: Abis.tip20, logs: mint.logs })) console.log("  event", l.eventName, l.args);
  const burn = await client.writeContractSync({
    address: token,
    abi: Abis.tip20,
    functionName: "burnWithMemo",
    args: [1_000_000n, memo],
    feeToken: PATH_USD,
  });
  console.log("smoke burn:", burn.status, burn.transactionHash);
  for (const l of parseEventLogs({ abi: Abis.tip20, logs: burn.logs })) console.log("  event", l.eventName, l.args);

  // 6. Can AcmeUSD actually pay fees? Mint 1, transfer 0.5 to self paying the fee in AcmeUSD.
  //    The fee lands in the Fee AMM; reclaim it (rebalanceSwap) so we can burn the full 1.0 and
  //    leave totalSupply exactly where the ledger expects it (0 for a fresh deployment).
  await client.token.mintSync({ token, to: me, amount: 1_000_000n, feeToken: PATH_USD });
  const t = await client.token.transferSync({ token, to: me, amount: 500_000n, feeToken: token });
  console.log("fee-in-AcmeUSD transfer:", t.receipt.status, t.receipt.transactionHash);
  for (const validatorToken of [ALPHA_USD, PATH_USD] as const) {
    const pool = await client.amm.getPool({ userToken: token, validatorToken });
    if (pool.reserveUserToken > 0n) {
      await client.amm.rebalanceSwapSync({ userToken: token, validatorToken, amountOut: pool.reserveUserToken, to: me, feeToken: PATH_USD });
      console.log(`reclaimed ${formatUnits(pool.reserveUserToken, 6)} AcmeUSD fee from the AMM`);
    }
  }
  const rest = await bal(token);
  if (rest > 0n) await client.token.burnSync({ token, amount: rest, feeToken: PATH_USD });
  console.log("treasury AcmeUSD balance now:", await bal(token), "| totalSupply:", await client.readContract({ address: token, abi: Abis.tip20, functionName: "totalSupply" }));

  console.log("\nAdd to .env:");
  console.log(`ACME_USD_ADDRESS=${token.toLowerCase()}`);
  console.log(`NEXT_PUBLIC_ACME_USD_ADDRESS=${token.toLowerCase()}`);
  console.log(`NEXT_PUBLIC_TREASURY_ADDRESS=${me.toLowerCase()}`);
  console.log(`TOKEN_DEPLOY_BLOCK=${deployBlock}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
