CREATE TABLE "agent_questions" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"owner" text,
	"owner_id" text,
	"color" text NOT NULL,
	"frame_id" text,
	"selector" text,
	"text" text NOT NULL,
	"at" bigint NOT NULL,
	"status" text NOT NULL,
	"answer" text,
	"answered_by" text,
	"answered_at" bigint,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "frame_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"kind" text NOT NULL,
	"frame_id" text,
	"name" text,
	"html" text,
	"x" double precision,
	"y" double precision,
	"width" double precision,
	"height" double precision,
	"base_updated_at" bigint NOT NULL,
	"summary" text NOT NULL,
	"agent_name" text NOT NULL,
	"owner" text,
	"owner_id" text,
	"color" text NOT NULL,
	"at" bigint NOT NULL,
	"status" text NOT NULL,
	"resolved_by" text,
	"resolved_at" bigint
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"user_id" text PRIMARY KEY NOT NULL,
	"agent_email" boolean DEFAULT false NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"run_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"at" bigint NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"ok" boolean,
	"ms" integer,
	"summary" text
);
--> statement-breakpoint
CREATE TABLE "run_journals" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"card_id" text,
	"summary" text NOT NULL,
	"decisions" text,
	"at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD COLUMN "review_mode" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "paused_at" bigint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "paused_by" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "priority" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "position" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "stage_summary" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "handback" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "usage" text;--> statement-breakpoint
CREATE INDEX "agent_questions_canvas_idx" ON "agent_questions" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "frame_proposals_canvas_idx" ON "frame_proposals" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "run_events_canvas_idx" ON "run_events" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "run_journals_canvas_idx" ON "run_journals" USING btree ("canvas_id");