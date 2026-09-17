<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# AcmeUSD — guide for contributors (human or AI)

AcmeUSD is ACME's stablecoin on Tempo testnet. This app lets people create passkey wallets, deposit (fake USD → mint), withdraw (transfer → burn → fake USD), send/receive paying fees in AcmeUSD, and gives ACME an admin view of liabilities. **Read `DESIGN.md` before changing anything that touches money** — it is the source of truth for how the system is supposed to behave, and it must be updated in the same change as the code.

## Invariants (do not break these)

1. **The chain is the source of truth for balances; Postgres is the source of truth for fiat and intent.** Never cache token balances in the DB. Never trust an amount, sender or recipient from a client — verify from receipt logs (`src/lib/chain.ts#getReceiptTransfers`).
2. **Every issuer transaction is idempotent per (order, attempt)** via a 2D nonce key (`src/lib/nonce-key.ts`): `nonceKey = (orderUUID << 8) | attempt`, `nonce = 0`. Never send an issuer tx without a nonce key derived from an order, and never bump `attempt` on an *unknown* outcome (only on a known revert/rejection).
3. **Recover before you send.** Every mint/burn/transfer carries `memo = bytes32(orderId)`; look the memo up (`findTransfersByMemo`) before sending anything. Mint recovery requires `from == 0x0`; burn recovery requires `to == 0x0`.
4. **State transitions are status-guarded** (`src/lib/orders-db.ts#transition`: `UPDATE … WHERE status IN (…)`), the decision + claim phase runs under `SELECT … FOR UPDATE NOWAIT`, and no lock is ever held across a network call. Terminal states (`minted`, `failed`, `burned`, `needs_review`) are never left by code — `needs_review` only via the admin **Reopen** action.
5. **Amounts are `bigint` base units (6 decimals) end to end.** Decimal strings are parsed exactly once, at the API edge, by `parseAmount` (`src/lib/amounts.ts`). JSON carries them as strings (`src/lib/serialize.ts`).
6. **The ledger is scoped per token.** Every order/indexed transfer stores its `token`; every query filters on `ACME_USD_ADDRESS`; processing an order of another token throws `WrongTokenError`. One token per environment (local ≠ prod).
7. **Identity comes from the passkey session, never the body.** `requireUser` (`src/lib/auth.ts`) derives the address from the credential's public key and looks up its identity (`src/lib/identity.ts`); the optional `x-wallet` header is honoured only for another wallet of the *same identity* (`canActFor`). Registration semantics live in `webAuthnHandler`'s `onRegister`: no session → new identity (name = username), session → new wallet (name = label).
8. **Never guess in the ambiguous case** ("nonce consumed but no log"): park in `needs_review`. Guessing "reverted" can double-mint; guessing "succeeded" can strand a user.

## Map

| Area | Where | Notes |
|---|---|---|
| Chain adapter | `src/lib/chain.ts` | The only viem code for issuer ops. `TxOutcome = success \| reverted \| rejected \| unknown`. `classifyError` maps RPC errors by *meaning* (nonce-too-low = included; already-known = pending; transport = unknown). `CHAOS=` env injects faults. Injectable `client` for tests. |
| State machines | `src/lib/onramp.ts`, `src/lib/offramp.ts` | `processX(id)` is idempotent and re-drivable (UI Retry, admin Reprocess, cron). Read the phase comments before editing. |
| DB helpers | `src/lib/orders-db.ts` | `lockOrder`, `transition`, `listByStatus(table, statuses, token)`, `assertCurrentToken`. |
| Schema / migrations | `src/db/schema.ts`, `drizzle/` | `pnpm db:generate` after schema edits; migrations run on every Vercel build and at Docker start. Additive only — the prod DB is live. |
| Auth / identities | `src/lib/auth.ts`, `src/lib/identity.ts`, `src/app/api/auth/[[...route]]`, `src/app/api/session`, `src/app/api/identity/available`, `src/app/api/wallets/[address]` | Passkey ceremony from `accounts/server` backed by Postgres (`src/lib/kv-postgres.ts`); username + wallets per identity; admin password → HMAC cookie. |
| API | `src/app/api/**` | Wrap handlers in `handle()` (`src/lib/api.ts`) for error mapping; validate bodies with zod via `readJson`; validate path ids with `requireUuid`. |
| Admin | `src/lib/admin.ts`, `src/components/admin-dashboard.tsx` | Liabilities, three reconciliations, holder index (`syncHolders`), `reprocessStuck`, `reopenOrder`. |
| Activity | `src/lib/activity.ts` | Incremental per-wallet index of `Transfer` logs (`transfer_events`, cursor on `users.synced_block/sync_token`) merged with orders by `buildActivity` (pure). |
| Wallet UI | `src/app/wallet/page.tsx`, `src/components/*-dialog.tsx`, `wallet-switcher.tsx`, `connect-button.tsx`, `src/lib/use-wallet.ts`, `src/lib/use-wallets.ts` | Register (username → passkey) / Sign in; deposit/withdraw/send are dialogs whose whole lifecycle (including passkey signing) stays in the popup; `useOrder` polls an order while pending. The identity's wallets come from `/api/session`; switching reorders the SDK store (no passkey prompt when the account is already on this device). |
| Client config | `src/lib/client-config.ts`, `src/lib/wagmi.ts` | Only `NEXT_PUBLIC_*` reach the browser. `wagmiConfig()` is a singleton shared by React and the API client. |
| Ops scripts | `scripts/setup-token.ts` (create token + seed fee AMM, leaves supply 0), `scripts/inspect.ts` (where is every unit), `scripts/reclaim-fees.ts` (pull fee revenue from the AMM and burn), `scripts/e2e.md` (manual + chaos script) | Ops scripts use nonce key 0; the app never does. |

## Tempo facts that shape the code (details in `RESEARCH.md`)

- No native gas token; fees are paid in USD TIP-20s. Users pay in AcmeUSD (`feeToken` on every user tx — requires the Fee AMM pools seeded by `setup-token`); the issuer pays in pathUSD so mints never depend on our own pool.
- `mintWithMemo` emits `TransferWithMemo(0x0 → to, memo)`, `burnWithMemo` emits `TransferWithMemo(from → 0x0, memo)`; memo is an indexed topic. Fees paid in AcmeUSD show up as a `Transfer(payer → 0xfeec…)` in the same receipt and **move** tokens — they never change `totalSupply`.
- Deterministic reverts (supply cap, paused, missing role) fail at gas estimation → arrive as thrown *rejections*, not reverted receipts. They count as attempts.
- `eth_getLogs` is capped at ~100k blocks per call; index in ≤50k chunks.
- SDK traps: use `authUrl` (not `auth: {url}`) on the wagmi `webAuthn` connector; `mintSync`/`burnSync` decode events unconditionally, so we use `writeContractSync` + `receipt.status`; `token.getBalance` returns an `Amount` object, use `readContract`. wagmi's `connect()` refuses while connected — talk to the provider (`wallet_connect`) to switch/add accounts.

## Working on it

```bash
docker compose up -d db          # Postgres on :5434 (tests use acmeusd_test on the same container)
pnpm install && pnpm db:migrate
pnpm dev                          # :3000 (RP_ID/ORIGIN default to localhost)
pnpm typecheck && pnpm lint && pnpm test   # CI runs exactly these + next build + docker build
```

- **Tests are the spec for the money paths.** `src/lib/__tests__/` runs the real state machines against Postgres with a mock chain (`src/test/mock-chain.ts`) that enforces the one protocol rule everything leans on (a `(nonceKey, 0)` pair is consumable once). If you change a transition, add or update the test that pins it. Never let the dev DB be the test DB.
- **Passkeys can't be automated.** WebAuthn refuses in an unfocused/automated window; drive everything else and ask a human for the tap. Registering under an existing user handle *replaces* the passkey — new wallets need a fresh handle (the SDK does this).
- **Env**: `src/lib/env.ts` validates on first use; blank values are treated as unset (Vercel's UI saves blanks). Neon injects `TEMPO_DATABASE_URL(_UNPOOLED)`; the migrator prefers the unpooled URL.
- **Docs**: update `DESIGN.md` for behaviour changes, `RESEARCH.md` for newly verified protocol/SDK facts, `AI_THREADS.md` if you are an AI working with the owner (prompts verbatim, steering, mistakes — no raw transcripts).
- **Commits/deploys**: `main` deploys to production automatically (migrations included). Don't commit `.env`; never print the issuer key.

## Things deliberately not done (see DESIGN.md §8)

Fee-sponsored first transfers (`Handler.relay`), TIP-403 compliance freezes, historical admin snapshots/alerting, indexer-API log scans, a real PSP (would replace `src/lib/fiat-stub.ts` on the `created → payment_captured` edge with an outbox/idempotency-key pattern), a CSP.
