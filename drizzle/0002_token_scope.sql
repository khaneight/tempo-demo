ALTER TABLE "offramp_orders" ADD COLUMN "token" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "onramp_orders" ADD COLUMN "token" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "transfer_events" ADD COLUMN "token" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "sync_token" text;