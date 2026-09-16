CREATE TABLE "canvas_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"cause" text NOT NULL,
	"frames" jsonb NOT NULL,
	"tokens" jsonb,
	"created_at" bigint NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "components" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "guidelines" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "pages" ADD COLUMN "deleted_at" bigint;--> statement-breakpoint
CREATE INDEX "canvas_versions_canvas_idx" ON "canvas_versions" USING btree ("canvas_id","created_at");