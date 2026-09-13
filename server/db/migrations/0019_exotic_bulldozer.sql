CREATE TABLE "canvas_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"name" text NOT NULL,
	"frames" jsonb NOT NULL,
	"tokens" jsonb,
	"created_at" bigint NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "canvas_releases_canvas_idx" ON "canvas_releases" USING btree ("canvas_id","created_at");