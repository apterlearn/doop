CREATE TABLE "canvas_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"before" jsonb,
	"proposed_by" text NOT NULL,
	"proposed_by_user" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolution_note" text,
	"created_at" bigint NOT NULL,
	"resolved_at" bigint
);
--> statement-breakpoint
CREATE INDEX "canvas_proposals_canvas_idx" ON "canvas_proposals" USING btree ("canvas_id");