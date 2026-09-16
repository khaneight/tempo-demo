import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Ledger schema.
 *
 * Amounts are TIP-20 base units (6 decimals) stored as Postgres bigint and
 * surfaced as JS bigint. There is deliberately NO cached token balance table:
 * the chain is the source of truth for balances; these tables are the source
 * of truth for fiat movements and for what we *intended* to do on-chain.
 */

export const users = pgTable("users", {
  /** Lowercase 0x address derived from the passkey public key. */
  address: text("address").primaryKey(),
  credentialId: text("credential_id").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const onrampStatus = pgEnum("onramp_status", [
  "created", // row exists, nothing charged
  "payment_captured", // fiat captured; we OWE the user tokens
  "minting", // mint tx handed to RPC; outcome not yet recorded
  "minted", // terminal success
  "failed", // terminal; fiat refunded (see refundedAt)
  "needs_review", // an attempt consumed its nonce but no mint was found — operator decides
]);
export type OnrampStatus = (typeof onrampStatus.enumValues)[number];

export const onrampOrders = pgTable(
  "onramp_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userAddress: text("user_address")
      .notNull()
      .references(() => users.address),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    /** bytes32 hex derived from id; unique by construction. */
    memo: text("memo").notNull().unique(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: onrampStatus("status").notNull().default("created"),
    paymentRef: text("payment_ref"),
    /** Stubbed payment method (masked); never holds full credentials. */
    paymentDetails: jsonb("payment_details").$type<{ name: string; last4: string }>(),
    /** Feeds the per-order nonceKey; bumped only on a *known* failed attempt. */
    mintAttempt: integer("mint_attempt").notNull().default(0),
    mintStartedAt: timestamp("mint_started_at", { withTimezone: true }),
    mintTxHash: text("mint_tx_hash").unique(),
    /** Lower bound for memo log scans. */
    createdBlock: bigint("created_block", { mode: "bigint" }).notNull(),
    lastError: text("last_error"),
    refundedAt: timestamp("refunded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("onramp_user_idx").on(t.userAddress), index("onramp_status_idx").on(t.status)],
);
export type OnrampOrder = typeof onrampOrders.$inferSelect;

export const offrampStatus = pgEnum("offramp_status", [
  "created", // memo issued; waiting for the user's on-chain transfer
  "transfer_verified", // receipt verified: tokens in treasury; we OWE the user fiat
  "credited", // fiat paid out; burn pending — user is made whole here
  "burning", // burn tx handed to RPC; outcome not yet recorded
  "burned", // terminal success
  "expired", // no transfer seen within TTL (re-opens if one appears)
  "needs_review", // transfer found but from/amount mismatch — never auto-credited
]);
export type OfframpStatus = (typeof offrampStatus.enumValues)[number];

export const offrampOrders = pgTable(
  "offramp_orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userAddress: text("user_address")
      .notNull()
      .references(() => users.address),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    memo: text("memo").notNull().unique(),
    status: offrampStatus("status").notNull().default("created"),
    /** UNIQUE: one on-chain transfer can satisfy at most one order. */
    transferTxHash: text("transfer_tx_hash").unique(),
    transferFrom: text("transfer_from"),
    /** What the chain actually says was transferred. */
    transferAmount: bigint("transfer_amount", { mode: "bigint" }),
    creditedAt: timestamp("credited_at", { withTimezone: true }),
    payoutRef: text("payout_ref"),
    /** Stubbed destination (masked); never holds full credentials. */
    payoutDetails: jsonb("payout_details").$type<{ accountName: string; last4: string }>(),
    burnAttempt: integer("burn_attempt").notNull().default(0),
    burnStartedAt: timestamp("burn_started_at", { withTimezone: true }),
    burnTxHash: text("burn_tx_hash").unique(),
    createdBlock: bigint("created_block", { mode: "bigint" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("offramp_user_idx").on(t.userAddress), index("offramp_status_idx").on(t.status)],
);
export type OfframpOrder = typeof offrampOrders.$inferSelect;

/** Backing store for `accounts/server` (passkey credentials, challenges, sessions). */
export const kv = pgTable("kv", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
