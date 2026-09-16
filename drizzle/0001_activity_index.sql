CREATE TABLE "transfer_events" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"from_address" text NOT NULL,
	"to_address" text NOT NULL,
	"amount" bigint NOT NULL,
	"memo" text,
	CONSTRAINT "transfer_events_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "synced_block" bigint;--> statement-breakpoint
CREATE INDEX "transfer_from_idx" ON "transfer_events" USING btree ("from_address");--> statement-breakpoint
CREATE INDEX "transfer_to_idx" ON "transfer_events" USING btree ("to_address");