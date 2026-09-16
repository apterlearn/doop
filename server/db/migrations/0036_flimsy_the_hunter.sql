CREATE TABLE "canvas_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"accepted_at" bigint,
	"accepted_by" text,
	CONSTRAINT "canvas_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "canvas_members" ADD COLUMN "role" text DEFAULT 'editor' NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "link_password_hash" text;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "link_expires_at" bigint;--> statement-breakpoint
CREATE INDEX "canvas_invites_canvas_idx" ON "canvas_invites" USING btree ("canvas_id");