# End-to-end & chaos script (Tempo Moderato)

Prereqs: `.env` filled (see README), `docker compose up -d db`, `pnpm db:migrate`, `pnpm dev`. Admin at `/admin` (password from `.env`).

## Happy path
1. `/` → **Create a new wallet** → complete the passkey prompt → lands on `/wallet` with balance 0.
2. `/wallet` → **Deposit** → amount 25, test card (default Luhn-valid) → order page shows `USD received → Minting → Delivered`, mint tx link opens on the explorer.
3. `/wallet` shows 25.00. `/admin` → **Supply drift = 0**, reserves held $25, user liabilities 25.
4. `/wallet` → **Send** → 5 to a second wallet (create one in another browser profile) → recipient's Activity shows *Received 5.00*; the explorer shows the fee was paid in AcmeUSD, and the sender's Activity lists it under *Network fee* (toggle "hide network fees").
5. `/wallet` → **Withdraw** → 10, test bank → **Sign & send with passkey** inside the popup → `Transfer verified → USD sent → Tokens retired`; both tx links resolve; Activity shows the withdrawal.
6. `/admin` → supply drift still 0, reserves $15, pending burns 0.

## Resilience / chaos
7. **Lost mint response**: restart dev with `CHAOS=mint_unknown pnpm dev`; onramp 3 → order sits in `minting` ("Working on it…"); after 60 s the page (or **Retry**) recovers the mint by memo → `minted`. Explorer shows exactly **one** mint for that memo.
8. **Reverting mint**: `CHAOS=mint_revert pnpm dev`; onramp 2 → `payment_captured` with "mint reverted"; each Retry bumps `mint_attempt`; after 5 → `failed` + refund. (Real deterministic failure: lower the supply cap with `client.token.setSupplyCapSync` — it surfaces as a *pre-broadcast rejection*, the order stays `minting` for the 60 s backoff window between attempts, and after 5 attempts → `failed` + refund. Raise the cap before the 5th attempt to watch it recover instead.)
9. **Closed tab mid-offramp**: start an offramp, sign the transfer, kill the tab before the page posts the hash. Reopen `/wallet` → open the order → **I already sent it — check status** → memo lookup finds the transfer → `burned`.
10. **Replay**: `curl -X POST -b "$COOKIE" localhost:3000/api/offramp/<id>/process -d '{"txHash":"<same hash>"}'` three times → one credit, one burn (check `payout_ref`, `burn_tx_hash` unchanged; admin counts).
11. **Wrong amount**: create an offramp for 4, then via **Send** transfer 3 to the treasury address with memo = the order's memo (paste the 32-byte hex as the memo is not possible via the UI, so use a viem script) → order goes `needs_review`, no payout, admin shows the row and unattributed treasury = 3.
12. **Unattributed deposit**: **Send** 1 AcmeUSD to the treasury address with memo "oops" → admin "Unattributed treasury deposits" = 1; supply drift stays 0.
13. **Concurrency**: hit `/api/onramp/<id>/process` twice in parallel → one `200`, one `409 {inProgress:true}`.
14. **Sweep**: admin → **Reprocess stuck orders** with nothing stuck → "No stuck orders."; with a `minting` order older than 60 s → it is re-driven.

## Docker
15. `docker compose up --build` from a clean clone with only `.env` → app on :3000 runs migrations then serves; repeat step 1–3 against it.
