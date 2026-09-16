# AcmeUSD — stablecoin issuance on Tempo

ACME's stablecoin, live on Tempo testnet (Moderato). Users create a **passkey wallet**, **buy** AcmeUSD with (simulated) USD, **send** it paying fees in AcmeUSD, and **cash out** back to USD. Admins get a live **liabilities + reconciliation** dashboard.

- Design doc: [`DESIGN.md`](./DESIGN.md) · Research notes: [`RESEARCH.md`](./RESEARCH.md) · AI threads: [`AI_THREADS.md`](./AI_THREADS.md)
- Token: [`0x20c0…5ac7553a9946a27a`](https://explore.testnet.tempo.xyz/address/0x20c0000000000000000000005ac7553a9946a27a) (TIP-20 "Acme USD" / `AcmeUSD`, 6 decimals) · Treasury/issuer: `0x5909…8a46`
- Manual test + chaos script: [`scripts/e2e.md`](./scripts/e2e.md)

## Stack
Next.js 16 (App Router, route handlers) · wagmi 3 + viem 2 (`viem/tempo`, `wagmi/tempo`) · `accounts/server` for passkey ceremonies · Postgres + Drizzle · Tailwind + shadcn/ui · vitest · Docker · Vercel.

## Run locally

```bash
cp .env.example .env         # fill ISSUER_PRIVATE_KEY, ADMIN_PASSWORD, AUTH_SECRET (see below)
docker compose up -d db      # Postgres on localhost:5434
pnpm install
pnpm db:migrate
pnpm setup:token             # one-time: faucet → create AcmeUSD → issuer role → seed fee AMM; paste the printed addresses into .env
pnpm dev                     # http://localhost:3000
```

Fully containerized (app + db):

```bash
docker compose up --build    # runs migrations, serves on :3000
```

Passkeys work on `localhost` out of the box. For any other host set `RP_ID` (bare domain) and `ORIGIN` (`https://…`).

### Environment

| var | purpose |
|---|---|
| `DATABASE_URL` | Postgres (Neon on Vercel) |
| `ISSUER_PRIVATE_KEY` | secp256k1 key of the ACME issuer **= treasury** (`DEFAULT_ADMIN_ROLE` + `ISSUER_ROLE` on the token) |
| `ACME_USD_ADDRESS`, `TOKEN_DEPLOY_BLOCK` | output of `pnpm setup:token` |
| `NEXT_PUBLIC_ACME_USD_ADDRESS`, `NEXT_PUBLIC_TREASURY_ADDRESS`, `NEXT_PUBLIC_EXPLORER_URL` | same, for the browser |
| `ISSUER_FEE_TOKEN` | token the issuer pays *its* fees in (pathUSD; faucet-funded) |
| `RP_ID`, `ORIGIN` | WebAuthn relying party |
| `ADMIN_PASSWORD`, `AUTH_SECRET` | admin login + cookie signing |
| `CRON_SECRET` | authorizes the Vercel cron that sweeps stuck orders |
| `CHAOS` | test-only fault injection: `mint_unknown`, `mint_revert`, `burn_unknown` |

## Test

```bash
pnpm test        # vitest (64 tests): state machines against a dedicated `acmeusd_test` Postgres DB with a mock chain
                 # (double-mint / double-credit / recovery / concurrency), chain adapter contract, admin reconciliation, auth, Kv
pnpm typecheck && pnpm lint
```

## Ops scripts

```bash
pnpm exec tsx scripts/inspect.ts [address…] [--tx 0x…]   # where is every AcmeUSD; decode a tx's nonceKey/feeToken
pnpm exec tsx scripts/reclaim-fees.ts [units|all]        # pull AcmeUSD fee revenue out of the Fee AMM and burn it
```

## Deploy (Vercel)
GitHub → Vercel project; add the env vars above (Neon integration provides `DATABASE_URL`); build runs `next build`; migrations: `pnpm db:migrate` against the Neon URL (once, or in a build step). `vercel.json` schedules `/api/admin/reprocess` every 6 h (cron needs `CRON_SECRET`).

## Admin
`/admin` — password is `ADMIN_PASSWORD` from the environment (reviewers: see the submission email / Vercel env).
