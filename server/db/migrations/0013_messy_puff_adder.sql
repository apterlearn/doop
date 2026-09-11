CREATE TABLE "pages" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "page_id" text;--> statement-breakpoint
CREATE INDEX "pages_canvas_idx" ON "pages" USING btree ("canvas_id");