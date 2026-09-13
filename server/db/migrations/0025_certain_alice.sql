CREATE TABLE "components" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"html" text NOT NULL,
	"width" double precision NOT NULL,
	"height" double precision NOT NULL,
	"props" jsonb,
	"variant_of" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"card_ids" jsonb,
	"model" text,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"source_canvas_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "review_policy" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "approval_tools" jsonb;--> statement-breakpoint
ALTER TABLE "run_events" ADD COLUMN "frame_id" text;--> statement-breakpoint
ALTER TABLE "run_events" ADD COLUMN "before_version_id" text;--> statement-breakpoint
ALTER TABLE "run_events" ADD COLUMN "after_version_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "scheduled_at" bigint;--> statement-breakpoint
CREATE INDEX "components_canvas_idx" ON "components" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "run_steps_run_idx" ON "run_steps" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "runs_canvas_idx" ON "runs" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "user_memory_user_idx" ON "user_memory" USING btree ("user_id");