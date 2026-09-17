# AcmeUSD — stablecoin issuance on Tempo

ACME's stablecoin, live on Tempo testnet (Moderato). Users create a **passkey wallet**, **buy** AcmeUSD with (simulated) USD, **send** it paying fees in AcmeUSD, and **cash out** back to USD. Admins get a live **liabilities + reconciliation** dashboard.

- Design doc: [`DESIGN.md`](./DESIGN.md) · Research notes: [`RESEARCH.md`](./RESEARCH.md) · AI threads: [`AI_THREADS.md`](./AI_THREADS.md)
- Token: [`0x20c0…5ac7553a9946a27a`](https://explore.testnet.tempo.xyz/address/0x20c0000000000000000000005ac7553a9946a27a) (TIP-20 "Acme USD" / `AcmeUSD`, 6 decimals) · Treasury/issuer: `0x5909…8a46`
- Manual test + chaos script: [`scripts/e2e.md`](./scripts/e2e.md)
- Admin password: tempo123

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
| `DATABASE_URL` (or `TEMPO_DATABASE_URL` + `TEMPO_DATABASE_URL_UNPOOLED` as injected by the Vercel Neon integration with the `TEMPO_` prefix) | Postgres |
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
pnpm test        # vitest (70+ tests): state machines against a dedicated `acmeusd_test` Postgres DB with a mock chain
                 # (double-mint / double-credit / recovery / concurrency), chain adapter contract, admin reconciliation, auth, Kv
pnpm typecheck && pnpm lint
```

## Ops scripts

```bash
pnpm exec tsx scripts/inspect.ts [address…] [--tx 0x…]   # where is every AcmeUSD; decode a tx's nonceKey/feeToken
pnpm exec tsx scripts/reclaim-fees.ts [units|all]        # pull AcmeUSD fee revenue out of the Fee AMM and burn it
```

## CI
`.github/workflows/ci.yml` runs on every push/PR: typecheck, lint, the test suite against a Postgres service container, `next build`, and a Docker image build.

## Deploy (Vercel + Neon)
Automatic: every push to `main` deploys production; PRs get preview deployments. `vercel.json` sets the build command to **`pnpm db:migrate && pnpm build`**, so migrations are applied to the linked Neon database on every deployment (idempotent; uses Neon's unpooled URL for the migrator). The cron sweeps stuck orders every 6 h.

One-time setup checklist:
1. Vercel → **Add New → Project** → import `khaneight/tempo-demo` (framework: Next.js, root `/`). Don't deploy yet.
2. Project → **Storage → Create Database → Neon (free)** → connect to all environments with the env prefix `TEMPO_`. This injects `TEMPO_DATABASE_URL` (pooled) and `TEMPO_DATABASE_URL_UNPOOLED` (used by the migrator).
3. Project → **Settings → Environment Variables** (Production + Preview): `ISSUER_PRIVATE_KEY`, `ISSUER_FEE_TOKEN`, `ACME_USD_ADDRESS`, `TOKEN_DEPLOY_BLOCK`, `TEMPO_RPC_URL`, `NEXT_PUBLIC_ACME_USD_ADDRESS`, `NEXT_PUBLIC_TREASURY_ADDRESS`, `NEXT_PUBLIC_EXPLORER_URL`, `ADMIN_PASSWORD` (≥ 8 chars), `AUTH_SECRET` (≥ 32 random chars), `CRON_SECRET` (random; Vercel sends it as the cron's bearer token). Leave `RP_ID`/`ORIGIN` unset — they default to the deployment URL — unless you attach a custom domain (then set both).
4. **Deploy** (Deployments → Redeploy, or push to `main`). The build log should show `migrations applied (unpooled connection)`.
5. Smoke test on the production URL: create a passkey wallet → buy → cash out → `/admin` reconciliation balanced. Passkeys created on a preview URL belong to that hostname only.
6. Optional: Settings → Cron Jobs shows `/api/admin/reprocess`; hit it once manually with `Authorization: Bearer $CRON_SECRET` to confirm 200.

