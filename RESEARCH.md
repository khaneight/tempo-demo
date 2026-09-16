# Research Notes — Tempo, TIP-20, and the TypeScript SDKs

Collected 2026-09-15 from `tempo.xyz/developers/docs` (note: `docs.tempo.xyz/*` 308-redirects there; append `.md` to any docs URL for raw markdown; index at `https://tempo.xyz/developers/llms.txt`), `viem.sh/tempo`, `wagmi.sh/tempo`, `accounts.tempo.xyz`, and by unpacking the published npm packages and reading their `.d.ts` files.

## 1. Network

| | Testnet (Moderato) | Mainnet |
|---|---|---|
| Chain ID | **42431** | 4217 |
| RPC | `https://rpc.moderato.tempo.xyz` (`wss://` too) | `https://rpc.tempo.xyz` |
| Explorer | `https://explore.testnet.tempo.xyz` | `https://explore.tempo.xyz` |
| viem chain | `tempoModerato` (alias `tempoTestnet`) from `viem/tempo/chains` / `viem/chains` / `wagmi/chains` | `tempo` |

- **No native gas token.** `eth_getBalance` returns a constant; `CALLVALUE` is always 0. Balances live in TIP-20 contracts. Fees are USD-denominated and paid in USD TIP-20 stablecoins.
- Block time ~1s. Sync RPC `eth_sendRawTransactionSync` returns the receipt in-call.
- **Faucet**: `POST https://tempo.xyz/developers/api/faucet {"address":"0x…"}` (lowercase) or JSON-RPC `tempo_fundAddress`, or viem `client.faucet.fundSync({ account })`. Mints 1,000,000 each of pathUSD `0x20c0000000000000000000000000000000000000`, AlphaUSD `…0001`, BetaUSD `…0002`, ThetaUSD `…0003`.

## 2. TIP-20 token standard

Spec: https://tempo.xyz/developers/docs/protocol/tip20/spec

- **Factory precompile** `0x20Fc000000000000000000000000000000000000`: `createToken(name, symbol, currency, quoteToken, admin, salt[, logoURI])`. A `currency == "USD"` token must have a USD-denominated quote token (pathUSD). Only USD tokens can pay fees.
- `decimals()` is always **6**. Creation defaults: transfer policy 1 (always-allow), supply cap = uint128 max, unpaused, admin gets `DEFAULT_ADMIN_ROLE`.
- Roles (`keccak256("<NAME>")`): `ISSUER_ROLE` (mint/burn), `PAUSE_ROLE`, `UNPAUSE_ROLE`, `BURN_BLOCKED_ROLE`, `DEFAULT_ADMIN_ROLE` (supply cap, policy, quote token, logo). SDK role names: `issuer | pause | unpause | burnBlocked | defaultAdmin`.
- Supply/memo API: `mint(to,amount)`, `mintWithMemo(to,amount,bytes32)`, `burn(amount)`, `burnWithMemo(amount,memo)` — **burn burns from `msg.sender`** (so the treasury holding tokens to burn must be an issuer), `burnBlocked(from,amount)`, `transferWithMemo(to,amount,memo)`, `transferFromWithMemo`.
- Events: `Transfer(from,to,amount)`, `TransferWithMemo(from indexed, to indexed, amount, memo indexed)`, `Mint(to,amount)`, `Burn(from,amount)`, `BurnBlocked`, `Approval`, `SupplyCapUpdate`, `PauseStateUpdate`, `RoleMembershipUpdated`, …
- **Verified on Moderato (the recovery design depends on this):** `mintWithMemo` emits `Transfer(0x0→to)`, `TransferWithMemo(0x0→to, memo)` and `Mint(to)`; `burnWithMemo` emits `Transfer(from→0x0)`, `TransferWithMemo(from→0x0, memo)` and `Burn(from)`. So a mint is recoverable as `TransferWithMemo` with `from == 0x0` and a burn as `to == 0x0`, both filterable by the indexed memo. (The fee paid in a stablecoin shows up as an extra `Transfer(payer→FeeManager 0xfeec…)` in the same receipt.)
- Deterministic reverts (`SupplyCapExceeded`, paused, missing role) fail at `eth_estimateGas` *before* broadcast when using viem's write actions, so they arrive as thrown errors, not as reverted receipts.
- Reverts to expect: `SupplyCapExceeded`, `PolicyForbids`, paused, `InvalidRecipient` (cannot transfer to a TIP-20 contract address).
- Receive policies (T6): a blocked receive **still succeeds** and is redirected to `ReceivePolicyGuard 0xB10C…0000` with a `TransferBlocked` event — another reason to verify transfers from logs, not from "the tx didn't revert".
- TIP-403 registry `0x403c…0000`: whitelist/blacklist policies (`createPolicy`, `modifyPolicyWhitelist/Blacklist`, `isAuthorized`). Not used in v1.

## 3. Fees & the Fee AMM

Specs: `/protocol/fees/spec-fee`, `/protocol/fees/spec-fee-amm`.

- Fee-token precedence: (1) tx `feeToken` field → (2) `FeeManager.setUserToken` preference → (3) the TIP-20 being called (`transfer`/`transferWithMemo`) → (4) DEX `tokenIn` → (5) pathUSD fallback. The chosen token must be a USD TIP-20, the payer must hold ≥ `gasLimit × gasPrice`, and the **Fee AMM must have liquidity from that token into the validator's token**.
- `FeeManager` / Fee AMM precompile `0xfeec000000000000000000000000000000000000`: `setUserToken(address)`, `getUserToken`, `mint(userToken, validatorToken, amountValidatorToken, to)` (single-sided liquidity), `burn`, `rebalanceSwap`, `getPool` → `{ reserveUserToken, reserveValidatorToken, totalSupply }`. Fixed swap rate 0.997 (0.3% to LPs); `MIN_LIQUIDITY = 1000` burned by first LP.
- **Testnet validators accept AlphaUSD and pathUSD.** To let AcmeUSD pay fees: seed pools AcmeUSD→AlphaUSD and AcmeUSD→pathUSD once, then users pass `feeToken: AcmeUSD` per tx (or call `setUserToken`).
- Fee math: attodollars per gas; a ~50k-gas transfer costs ≈ $0.0006 at the mainnet cap. Transfers to a fresh address cost ~300k gas (account creation).

## 4. Tempo transaction type 0x76

Spec: `/protocol/transactions/spec-tempo-transaction`.

Fields: `[chain_id, max_priority_fee_per_gas, max_fee_per_gas, gas, calls[], access_list, nonce_key, nonce, valid_before, valid_after, fee_token, fee_payer_signature, aa_authorization_list, key_authorization, signature]`.

- `calls` batch executes atomically; `fee_token` overrides all preferences; `fee_payer_signature` enables sponsorship (**fee payers must be secp256k1**); `valid_after/before` for scheduling.
- **2D nonces**: `nonce_key = 0` is the protocol nonce; keys > 0 are independent sequences stored in the Nonce precompile `0x4E4F4E4345000000000000000000000000000000` (`getNonce(address,uint256)`). Fresh key costs +22,100 gas; reuse +5,000. Keys with MSB `0x5b` are reserved; `maxUint256` is the expiring-nonce key.
- **Native signature types**: secp256k1 (no prefix), **P256** (`0x01`), **WebAuthn/passkey** (`0x02`, `authenticatorData||clientDataJSON` + r,s,pubX,pubY), Keychain/access key (`0x03`). P256/WebAuthn **address = last 20 bytes of `keccak256(pubX ‖ pubY)`**.
- Doc inconsistencies noticed: one RPC page says type `0x54` (everything else says `0x76`); one issuance snippet calls `setTransactionFeeToken` (spec says `setUserToken`).

## 5. SDKs (verified against published packages, 2026-09-15)

| Package | Version | Role |
|---|---|---|
| `viem` | 2.56.5 | Tempo built in: `viem/tempo`, `viem/tempo/chains`, `viem/tempo/actions` |
| `wagmi` | 3.7.7 | `wagmi/tempo` → `webAuthn` connector, `Hooks.*`; peers `viem 2.x`, `@tanstack/react-query ≥5`, TS ≥ 5.9.3 |
| `accounts` | 0.18.4 | Tempo Accounts SDK; required by the `webAuthn` connector; `accounts/server` has `Handler.webAuthn`, `Handler.relay`, `Kv` |
| `tempo.ts` | 0.14.2 | **Do not use** — root export is empty; `tempo.ts/server` only has legacy `Handler.keyManager` / `Handler.feePayer` (superseded) |
| `tapimo` | 0.15.1 | **Do not use** — docs snippet imports `Handler` which the package doesn't export; pulls in stripe/pg/kysely |

### viem
```ts
import { Account, createClient, http, Abis, Addresses } from 'viem/tempo'
const client = createClient({ account: Account.fromSecp256k1(pk), testnet: true, feeToken: PATH_USD })
// pre-decorated: client.token.*, client.fee.*, client.amm.*, client.faucet.*, client.nonce.*, + public/wallet actions
await client.token.createSync({ name, symbol, currency: 'USD' })              // { admin, token, tokenId, receipt }
await client.token.grantRolesSync({ token, to, roles: ['issuer'] })
await client.token.mintSync({ token, to, amount, memo, nonceKey, feeToken })  // { ...MintEvent, receipt }
await client.token.burnSync({ token, amount, memo, nonceKey })
await client.token.transferSync({ token, to, amount, memo, feeToken })
await client.token.getBalance({ account, token }); await client.token.getMetadata({ token })
await client.fee.setUserTokenSync({ token }); await client.fee.getUserToken({ account })
await client.amm.mintSync({ userTokenAddress, validatorTokenAddress, validatorTokenAmount, to })
await client.amm.getPool({ userToken, validatorToken })
await client.faucet.fundSync({ account })
```
Every write accepts `feeToken, feePayer, nonceKey, nonce, validAfter, validBefore, throwOnReceiptRevert`. `…Sync` actions use `eth_sendRawTransactionSync` and return decoded event args + `receipt`. Caveat: `mintSync`/`burnSync` decode the `Mint`/`Burn` event unconditionally, so with `throwOnReceiptRevert: false` a reverted receipt makes the decode throw — the app calls `writeContractSync` with the TIP-20 ABI directly and branches on `receipt.status`. `token.getBalance` returns an `Amount` object, not a `bigint`; use `readContract(balanceOf)` when you need the raw integer. `Abis.tip20` includes `TransferWithMemo`, `Mint`, `Burn`; use `parseEventLogs` / `getLogs({ args: { memo } })` — memo is an indexed topic.

### wagmi
```ts
import { createConfig, http } from 'wagmi'
import { tempoModerato } from 'wagmi/chains'
import { webAuthn, Hooks } from 'wagmi/tempo'
// NB: use `authUrl` for the WebAuthn ceremony endpoint; `auth: { url }` is also read by the Provider
// as a SIWE-style auth capability and makes it call `${url}/challenge`.
createConfig({ chains: [tempoModerato], connectors: [webAuthn({ authUrl: '/api/auth', testnet: true })],
  multiInjectedProviderDiscovery: false, transports: { [tempoModerato.id]: http() } })
// Hooks.token.useTransferSync / useGetBalance / useGetMetadata / useWatchTransfer
// Hooks.fee.useSetUserTokenSync / useUserToken ; Hooks.faucet.useFundSync ; Hooks.amm.*
```
Sign-up and sign-in are both `connect()`; the connector runs register-or-authenticate. wagmi 3 examples use `useConnection()`.

### Passkey ceremonies (accounts)
- Client default is `WebAuthnCeremony.local()`: the credential's public key is stored **only in the browser (IndexedDB)**. The public key is not recoverable from a passkey later, so a user on another device could not derive their address → funds effectively stranded. **Use the server ceremony** (`auth: { url }`).
- Server: `Handler.webAuthn({ kv, origin, rpId, path, cookie, onRegister, onAuthenticate })` mounts `POST {path}/register/options|register|login/options|login|logout`, issues a session cookie, exposes `getSession(req) → { credentialId, publicKey, userId?, issuedAt, expiresAt }`. `onRegister` gets `{ credentialId, publicKey, name, userId }`.
- `Kv` interface: `get/set(ttl)/delete` + optional atomic `create` (create-if-absent) and `take` (read-and-delete). Only memory/Cloudflare/DurableObject adapters ship; we implement one over Postgres (`INSERT … ON CONFLICT DO NOTHING`, `DELETE … RETURNING`) so both atomic ops are linearizable.

### Fee sponsorship (not used in v1)
`Handler.relay({ feePayer: { account, feeToken, validate } })` from `accounts/server` + `withRelay(http(), http('/relay'))` transport (`withFeePayer` is deprecated). Public testnet sponsor: `https://sponsor.moderato.tempo.xyz`.

## 6. Implications for the design
1. Tie every issuer op to an order via the memo; recover lost hashes with `getLogs` by memo.
2. Verify offramp deposits from receipt **logs** (token address, event, to, from, amount, memo) — never from "tx succeeded".
3. Use 2D nonces to make issuer txs idempotent per order without cross-request locks.
4. Seed Fee AMM liquidity in the setup script or AcmeUSD cannot pay fees.
5. Store passkey public keys server-side.
