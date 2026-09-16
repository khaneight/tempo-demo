CREATE TYPE "public"."offramp_status" AS ENUM('created', 'transfer_verified', 'credited', 'burning', 'burned', 'expired', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."onramp_status" AS ENUM('created', 'payment_captured', 'minting', 'minted', 'failed', 'needs_review');--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "offramp_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_address" text NOT NULL,
	"amount" bigint NOT NULL,
	"memo" text NOT NULL,
	"status" "offramp_status" DEFAULT 'created' NOT NULL,
	"transfer_tx_hash" text,
	"transfer_from" text,
	"transfer_amount" bigint,
	"credited_at" timestamp with time zone,
	"payout_ref" text,
	"payout_details" jsonb,
	"burn_attempt" integer DEFAULT 0 NOT NULL,
	"burn_started_at" timestamp with time zone,
	"burn_tx_hash" text,
	"created_block" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "offramp_orders_memo_unique" UNIQUE("memo"),
	CONSTRAINT "offramp_orders_transfer_tx_hash_unique" UNIQUE("transfer_tx_hash"),
	CONSTRAINT "offramp_orders_burn_tx_hash_unique" UNIQUE("burn_tx_hash")
);
--> statement-breakpoint
CREATE TABLE "onramp_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_address" text NOT NULL,
	"amount" bigint NOT NULL,
	"memo" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "onramp_status" DEFAULT 'created' NOT NULL,
	"payment_ref" text,
	"payment_details" jsonb,
	"mint_attempt" integer DEFAULT 0 NOT NULL,
	"mint_started_at" timestamp with time zone,
	"mint_tx_hash" text,
	"created_block" bigint NOT NULL,
	"last_error" text,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "onramp_orders_memo_unique" UNIQUE("memo"),
	CONSTRAINT "onramp_orders_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "onramp_orders_mint_tx_hash_unique" UNIQUE("mint_tx_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"address" text PRIMARY KEY NOT NULL,
	"credential_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
ALTER TABLE "offramp_orders" ADD CONSTRAINT "offramp_orders_user_address_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onramp_orders" ADD CONSTRAINT "onramp_orders_user_address_users_address_fk" FOREIGN KEY ("user_address") REFERENCES "public"."users"("address") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "offramp_user_idx" ON "offramp_orders" USING btree ("user_address");--> statement-breakpoint
CREATE INDEX "offramp_status_idx" ON "offramp_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "onramp_user_idx" ON "onramp_orders" USING btree ("user_address");--> statement-breakpoint
CREATE INDEX "onramp_status_idx" ON "onramp_orders" USING btree ("status");