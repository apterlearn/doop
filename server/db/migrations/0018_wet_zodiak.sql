CREATE TABLE "frame_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"frame_id" text NOT NULL,
	"canvas_id" text NOT NULL,
	"html_sha" text NOT NULL,
	"frame_updated_at" bigint NOT NULL,
	"verdict" text NOT NULL,
	"summary" jsonb NOT NULL,
	"report" jsonb NOT NULL,
	"reviewed_at" bigint NOT NULL,
	"reviewed_by" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "frame_reviews_frame_idx" ON "frame_reviews" USING btree ("frame_id","reviewed_at");