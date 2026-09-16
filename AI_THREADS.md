# AI Threads Log

Running log of the AI-assisted sessions used to build this project (Claude Code; model: Claude Fable 5.1 / Opus 5 family).
Part 1 is every prompt I typed, verbatim and in order. Part 2 is what the AI did with each, how it was steered, and what it got wrong.

---

## Part 1 — Raw prompts (verbatim, chronological)

### P1 · 2026-09-15 · kickoff (sent in plan mode)

> lets plan out the implementation for a stablecoin issuance platform on Tempo. please store the ai threads in a log file as we go. i want a fullstack typescript app deployable on vercel via github. please read the spec doc below and research before coming up with implementation plan, also store in RESEARCH and DESIGN md files in directory root. DESIGN file is source of truth for implementation and should be kept in sync with current state
>
> Assignment
> Product Engineer Take Home
>
> Intended duration: 4 hrs
>
> You are at a company ACME that wants to issue their own stablecoin on Tempo. Your task is to design and implement a web application that lets users onramp AcmeUSD.
>
> Product Requirements
>
> Users can create a new wallet using passkeys on Tempo.
>
> Users can onramp funds by sending in (fake) USD and receiving AcmeUSD on testnet.
>
> Users can offramp AcmeUSD tokens and receive (fake) USD.
>
> Users can send and receive AcmeUSD, and pay for fees using AcmeUSD.
>
> ACME admins have a page where they can see their user and corporate liabilities.
>
> Technical Requirements
>
> There is a design doc that communicates the decisions you've made.
>
> Your project is deployed to a cloud service and we can use it end to end.
>
> Your code and all dependencies (database etc..) are containerized in an isolated runtime such as Docker
>
> You are allowed to use AI, but you should share threads, traces, or plan artifacts with us so we can see your process.
>
> Assumptions
>
> USD flows can be stubbed. The user can input payment credentials and you can assume that the transaction will execute without fraud.
>
> Blockchain flows should be real (on testnet) . All onchain operations should be executed with a new token that you create on Tempo's testnet.
>
> Assessment
>
> We will be evaluating you on the following broad criteria in rough priority order:
>
> Correctness and Safety. Do you meet all product requirements? Are there bugs that might lose money or introduce other safety issues?
>
> Architecture. Is the system simple and resilient against payment failures while still being easy to operate
>
> User Experience. Does the interface handle payment interactions well?
>
> Communication. Does the design doc explain the overall design, key decisions, and major tradeoffs?
>
> Include in Your Submission:
>
> A technical artifact with your solution (link to github repo, link to solution if it's deployed) please add the following to the github:
>
> brendanjryan, varunsrin, Slokh
>
> Record ~3-5min video of the technical design decision and general product overview
>
> Include AI threads you used. We're curious on how you steered the AI given everyone uses it now.
>
> After submitting, we will schedule a 45 minute call to go over the solution via zoom.
>
> Appendix
> Tempo docs: docs.tempo.xyz
> Explorer url: explore.tempo.xyz
> Tempo Testnet: https://docs.tempo.xyz/quickstart/integrate-tempo
> Tempo SDK: https://www.npmjs.com/package/tempo.ts
> Viem: https://viem.sh/tempo
> Wagmi: https://wagmi.sh/tempo/getting-started

### P2 · answers to the AI's planning questions (structured question UI)

- Database → **Postgres via Neon + Drizzle**
- Admin auth → **Shared admin password via env**
- UI stack → **Next.js + Tailwind + shadcn/ui**
- Repo & deploy → **Yes, init git + create GitHub repo + link Vercel** (AI to confirm before each outward-facing step)

### P3 · plan approval

Approved the implementation plan as written (plan-mode approval; no text). Per P1, the plan was written to the repo root — it became `DESIGN.md` (architecture, both state machines with every failure path, safety layers, admin reconciliation, tradeoffs) alongside `RESEARCH.md` — and the build that followed implemented it section by section, with the design doc updated whenever live testing changed a decision.

### P4 · browser selection

> Open a confirmation screen in every connected Chrome extension and let me select the right one there.

### P5 · after creating the passkey wallet by hand (the automated browser window could not run WebAuthn)

> ok seems the passkey works i created wallet

### P6 · after signing the offramp transfer by hand

> ok did it

### P7 · browser selection (session had reset)

> Browser 1 (macOS)

### P8 · declined the "publish now?" question and asked to clarify first, then:

> lets first review and map out what we've built so far, and also ensure the ai logs are storing all my raw prompts from the beginning as well

### P9 · verification pass (set as a session goal)

> lets verify the work done so far against the design and research docs, and ensure we have sufficient test coverage. prioritize testing the core business logic around mint/burn of acme usd. give me full report of tests added, issues found/resolved, security review, and any remaining gaps in features

### P10 · 2026-09-16 · publish

> ok now lets get it setup on this repo https://github.com/khaneight/tempo-demo ensure our gitignore is correct first

### P11 · 2026-09-16 · deployment pipeline

> ok great. now i want to focus on deployment. i want to connect github repo to vercel for automatic deployments, and use free neon database from vercel marketplace. migrations should be applied automatically on deployment and i want a ci on github actions to run tests. create the necessary actions and give me a checklist of steps needed for full deployment process.

### P12 · while wiring Vercel + Neon

> i added TEMPO_ prefix to the neon db env vars

### P13 · first production deploy

> getting zod error for DATABASE_URL in registration flow ensure its fixed everywhere

> check the vercel logs and fix *(pasted a Vercel request log: `POST /api/auth/register/options` → 500 on `tempo-demo-beta.vercel.app`, deployment `dpl_B7LWdzGu57uwQNDwEvNtuxWhZFHf`)*

### P14 · UI pass

> now lets improve the UI:
> - replace fonts use inter for text and jetbrains mono for numbers
> - on wallet page remove the network fee section, make deposit/withdraw/transfer flows popups instead of dedicated tabs
> - identicons on address in nav bar and wallet page, put account info and address at the top along with balances
> - have one unified transaction history with deposits/withdraws and send/recieve, with filtering and sorting options

---

## Part 2 — Sessions: what the AI did, how it was steered, what it got wrong

## Session 1 — 2026-09-15 — Research & planning (plan mode) · prompts P1–P3

### How the AI was steered

- **Research-first, in plan mode**: no code until Tempo docs and SDKs were verified. Two parallel research agents were given explicit fact lists (chain ids, precompile addresses, function signatures, import paths, package versions) and told to **flag uncertainty explicitly** rather than guess.
- SDK claims had to be verified against the **actual published npm packages** (unpacked `.d.ts`), not docs. This caught several stale-doc traps (below).
- Architecture choices were put to me as concrete options with a recommendation (P2). A third agent was scoped to the hardest sub-problem only: the onramp/offramp ledger state machine and payment-failure safety on serverless, under "no queues/workers, fit in ~4 hours".

### Research findings (summarized; full notes in `RESEARCH.md`)

- Testnet is **Moderato** (chain id 42431). No native gas token; fees are paid in USD TIP-20 stablecoins.
- TIP-20 tokens are created via a factory precompile; `mintWithMemo` / `burnWithMemo` / `transferWithMemo` carry an **indexed bytes32 memo** — used to tie every on-chain op to a ledger order id and to recover lost tx hashes.
- **A new token can only pay fees after Fee AMM liquidity is seeded** against the validators' token (AlphaUSD / pathUSD on testnet).
- Passkeys are protocol-native (WebAuthn signature type on tx 0x76).
- SDK traps caught by reading real packages: `tempo.ts` root export is empty (superseded by `accounts`); `KeyManager.*` no longer exists; `withFeePayer` is deprecated; `tempoAndantino` doesn't exist; `tapimo`'s doc snippet doesn't match the package; the default passkey ceremony is **local-only** (public key in browser IndexedDB → wallet unrecoverable cross-device), so the server ceremony was chosen.

### Key decisions

1. **Chain is the source of truth for balances; Postgres for fiat + intent.** No cached balances, no journal table — orders are the fiat ledger.
2. **Issuer = treasury** (one secp256k1 key), because `burn` burns from `msg.sender` and needs `ISSUER_ROLE`.
3. **Issuer tx idempotency via per-order `nonceKey`** (2D nonces): `(uuid128 << 8) | attempt`, nonce 0 → at most one inclusion per attempt, enforced by the protocol, with memo-indexed log lookup for recovery. No cross-request coordination on serverless.
4. **One idempotent `process(orderId)` per order kind**, re-drivable from a Retry button, an admin "Reprocess" button, and a cron. No workers.
5. Users pay fees in **AcmeUSD**; the issuer pays its own fees in **pathUSD** so mints never depend on the AcmeUSD Fee AMM pool.
6. No fee-sponsorship relay (users always hold AcmeUSD by the time they transfer); noted as future work.
7. Admin page computes liabilities live with chain-vs-ledger reconciliation checks.

---

## Session 2 — 2026-09-15 — Implementation & live testing · prompts P4–P8

### How the AI was steered

- **Verify before writing**: every SDK call the code depends on was checked against the installed package's `.d.ts` before use. This caught: viem's `mintSync` decoding the `Mint` event unconditionally (a reverted-but-not-thrown receipt would crash decoding → the code calls `writeContractSync` with the TIP-20 ABI and branches on `receipt.status`); `getBalance` returning an `Amount` object rather than `bigint` (→ `readContract`); wagmi's `auth: { url }` connector option being read as a SIWE capability (it called `/api/auth/challenge`) → use `authUrl`.
- **Smoke-test assumptions on the real chain first**: `scripts/setup-token.ts` creates the token, seeds the fee AMM, then does a memo'd mint + burn and prints decoded logs. This confirmed the two facts the recovery design relies on — `mintWithMemo` emits `TransferWithMemo(0x0 → user, memo)` and `burnWithMemo` emits `TransferWithMemo(treasury → 0x0, memo)` — before any state-machine code trusted them.
- **Tests before UI**: the processors were written against an injected `Chain` interface with a mock chain that enforces the one protocol rule the design leans on (a `(nonceKey, nonce 0)` pair is consumable once). 28 tests cover double-mint, double-credit, lost responses, reverts, lagging RPC reads, wrong-amount/wrong-sender deposits, expiry/re-open and row-lock concurrency. One test was found to be mislabeled on review and rewritten to exercise the real "nonce too low → recover hash" branch.
- **Ops hygiene the AI missed, caught by reading its output**: the test suite truncated the _dev_ database (shared `DATABASE_URL`) → tests moved to a dedicated `acmeusd_test` DB with a global migration step. Ports 5432/5433 were taken by other projects' containers → compose maps 5434. The dev server was repeatedly killed by the harness's low-memory heuristic → run detached.
- **Environment constraints handled honestly**: WebAuthn refuses to run in an unfocused automated Chrome window ("page does not have focus"), so passkey ceremonies (P5, P6) were done by hand while the AI drove everything else (form fills via React-compatible input events, admin login, verification through Postgres and on-chain reads).

### What live testing found

- Onramp end-to-end on Moderato: $25 captured → `mintWithMemo` → 25.00 AcmeUSD in the passkey wallet in one 3.1 s request. On-chain the mint tx shows `nonceKey = (orderUUID << 8) | 0`, `nonce 0`, fee in pathUSD — the idempotency design as specified.
- **The admin dashboard immediately flagged a 0.000049 AcmeUSD "supply drift".** The AI's first explanation — "fees paid in AcmeUSD are absorbed by the Fee AMM, so net them out of supply" — was **wrong**, and was caught only because the next data point contradicted it: after the offramp the AMM held 0.001052 but supply was 15.000049, i.e. fees had _moved_ tokens (user → AMM) without changing `totalSupply`. Netting the AMM balance out would have produced a negative drift and hidden the real cause: the setup script's smoke test had minted 1.000000 and burned 0.999951 _outside the ledger_. Fixes: reconciliation reverted to the honest `totalSupply − (Σ minted − Σ burned)`; the AMM balance is shown as ACME fee revenue and counted in Reconciliation C; `scripts/reclaim-fees.ts` (`rebalanceSwap` + burn) removed the 49-unit residue so supply is exactly 15.000000; the setup script now reclaims its own smoke-test fee and leaves supply at 0. The dashboard did its job; reasoning through the numbers beat the plausible story.
- Offramp end-to-end: the passkey-signed `transferWithMemo` paid its fee in **AcmeUSD** (`feeToken` on the tx = the AcmeUSD address), the server verified it from receipt logs, paid out, and burned with a per-order nonce key — one 4.1 s request. Replaying the same hash 3× produced the same payout ref and burn hash (no double credit).
- Docker image (`output: 'standalone'`) boots, applies migrations and serves; verified with `docker run` against the local DB.

### Decisions made in this session

- `needs_review` added to the onramp state machine for the one ambiguous case (an attempt's nonce consumed but no mint visible): a human decides rather than the code guessing "reverted" (risking a double mint) or "succeeded" (risking a stranded user).
- Explicit **Create wallet** vs **Sign in** buttons using the connector's `capabilities.method = 'register'`, instead of one ambiguous "connect" button.
- Base UI (shadcn v4) buttons rendered as links use `render=` + `nativeButton={false}`.

---

## Session 3 — 2026-09-15 — Verification pass · prompt P9

### How the AI was steered
- P9 was set as a **session goal** (the AI cannot stop until it has delivered the full report), with an explicit priority: the mint/burn business logic first.
- Two independent review agents were run in parallel with read-only access: one checking every claim in `DESIGN.md` §2–§5 against the code line by line and listing missing test cases per branch, one doing a security review with a fixed checklist (authn/authz, input validation, ledger safety, secrets, SQL, web, deployment). Findings had to be ranked, cite `file:line`, and come with a one-line fix — no generic advice.
- Meanwhile the chain adapter was made injectable so its exact behaviour (what a mint/burn *sends*, how every RPC outcome maps) could be pinned by tests instead of trusted.

### Issues found and resolved (all with tests)
1. **Deterministic reverts never counted as attempts (high).** viem estimates gas before broadcasting, so `SupplyCapExceeded`/paused/missing-role surface as thrown *rejections*; the state machine only bumped `mintAttempt` on on-chain reverts, so such an order would loop forever with the fiat held and never refund. Rejections now count; the order stays `minting` so the in-flight window doubles as backoff; after 5 → `failed` + refund (transition first, then refund).
2. **Concurrent callers could both pass the decision phase (medium).** The `minting` claim was written *after* the lock was released; a second caller could re-claim and re-send, and if its send came back "already known" it could park a *successful* mint as `needs_review`. The claim (and `mint_started_at`) now happens inside the locked transaction, for mints and burns alike.
3. **"already known" misclassified as "landed" (medium).** A tx still pending in the mempool was treated like "nonce too low" → recover-by-memo → nothing yet → `needs_review`. Now classified as unknown (wait, same key). viem's `NonceTooLowError` (phrase only in `details`) is now recognised by name.
4. **Mint recovery accepted any memo'd transfer to the user (medium).** A user could `transferWithMemo` to themselves with the order memo and flip the order to `minted` with no mint. Recovery now requires `from == 0x0`.
5. **Third parties could wedge an offramp (low).** Any transfer carrying a leaked memo parked the order in `needs_review`. Only the owner's transfers count now; foreign ones are ignored and surface as unattributed treasury deposits.
6. **`needs_review` had no exit.** Added an operator **Reopen** action (fresh attempt / fresh nonce key) in the admin UI and API.
7. **Liabilities ignored `needs_review` rows.** Captured-but-unminted fiat and credited-but-unburned tokens under review are now counted.
8. Security hardening from the review: onramp abuse limits (5 open / 20 per day / $50k per day), admin login throttling, HMAC key bound to the password (rotation revokes cookies), constant-time password compare, cron endpoint split (bearer on GET, cookie on POST) with timing-safe compare, sanitized RPC error text, uuid validation (404 not 500), strict JSON bodies, `cors: false` on the passkey handler, `x-forwarded-proto` handling for the `Secure` cookie, Postgres TLS verification, security headers, Docker `USER node`, Postgres bound to localhost, expired-challenge purge in the sweep, minimum secret lengths.

### Tests: 28 → 64
New suites: `chain.test.ts` (12: exactly what mint/burn send — function, args, nonce key, nonce 0, fee token — and every outcome mapping incl. NonceTooLowError/already-known/reverts/CHAOS), `admin.test.ts` (5: liabilities + reconciliation math with needs_review rows, drift/outsiders, reprocess sweep, reopen), `infra.test.ts` (8: passkey address derivation vs viem, admin cookie MAC/expiry/tamper, API error mapping without leakage, Postgres Kv atomic create/take + TTL). Extended: onramp (+6: rejection counting + backoff, fail+refund after 5 deterministic failures, hang → needs_review, resume after crash-before-send, race past the decision phase → one send, self-transfer not mistaken for mint, abuse limits) and offramp (+4: burn rejection cap with one payout, resume from persisted states, parallel same-hash submissions, foreign-sender transfers ignored).

### Docs kept in sync
`DESIGN.md` (both state diagrams, guards, needs_review exit, liabilities, new §7 security posture), `RESEARCH.md` (memo event shapes verified on-chain, pre-broadcast reverts, `authUrl`, SDK caveats), `scripts/e2e.md` (chaos step 8).

---
