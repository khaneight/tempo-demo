import {
  bigint,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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

/**
 * An identity is a person: a username plus one or more wallets (each its own
 * passkey). Registration creates the identity with its first wallet; a signed-in
 * identity can add wallets. Any of its passkeys signs it in.
 */
export const identities = pgTable("identities", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Lowercase, unique, 3–24 chars of [a-z0-9_-]. */
  username: text("username").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type Identity = typeof identities.$inferSelect;

export const users = pgTable("users", {
  /** Lowercase 0x address derived from the passkey public key. One row per wallet (= passkey). */
  address: text("address").primaryKey(),
  credentialId: text("credential_id").notNull().unique(),
  /** Owning identity. Null only for wallets registered before identities existed; backfilled on next sign-in. */
  identityId: uuid("identity_id").references(() => identities.id),
  /** Person-chosen wallet name (server-side so it follows the identity across devices). */
  label: text("label").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Last block whose AcmeUSD transfers for this wallet have been copied into transfer_events (for `sync_token`). */
  syncedBlock: bigint("synced_block", { mode: "bigint" }),
  /** Token address the sync cursor refers to; a different active token restarts from its deploy block. */
  syncToken: text("sync_token"),
});

/**
 * Per-wallet index of on-chain AcmeUSD Transfer logs (sends/receives/mints/burns/fees),
 * filled incrementally by the activity endpoint so the RPC is only ever asked for
 * the blocks since the last sync. Orders are joined to these by tx hash.
 */
export const transferEvents = pgTable(
  "transfer_events",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    /** Token contract the log came from; the ledger is scoped per token. */
    token: text("token").notNull().default(""),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    blockTime: timestamp("block_time", { withTimezone: true }).notNull(),
    from: text("from_address").notNull(),
    to: text("to_address").notNull(),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    memo: text("memo"),
  },
  (t) => [primaryKey({ columns: [t.txHash, t.logIndex] }), index("transfer_from_idx").on(t.from), index("transfer_to_idx").on(t.to)],
);
export type TransferEvent = typeof transferEvents.$inferSelect;

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
    /**
     * Token this order issues. The ledger is scoped per token so an environment
     * pointed at a new AcmeUSD sees only its own issuance (and never re-drives an
     * order that belongs to another token).
     */
    token: text("token").notNull().default(""),
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
    /** Token this order redeems (see onramp_orders.token). */
    token: text("token").notNull().default(""),
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
