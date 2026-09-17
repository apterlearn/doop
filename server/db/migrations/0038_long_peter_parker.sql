CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"client_id" text,
	"name" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_seen_at" bigint NOT NULL,
	"revoked_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agents_owner_name_idx" ON "agents" USING btree ("owner_id","name");