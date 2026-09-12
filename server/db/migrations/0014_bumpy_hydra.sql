CREATE TABLE "agent_plans" (
	"canvas_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"owner" text,
	"steps" jsonb NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "agent_plans_canvas_id_agent_name_pk" PRIMARY KEY("canvas_id","agent_name")
);
--> statement-breakpoint
CREATE TABLE "frame_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"frame_id" text NOT NULL,
	"canvas_id" text NOT NULL,
	"name" text NOT NULL,
	"html" text NOT NULL,
	"x" double precision NOT NULL,
	"y" double precision NOT NULL,
	"width" double precision NOT NULL,
	"height" double precision NOT NULL,
	"saved_at" bigint NOT NULL,
	"saved_by" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "frame_versions_frame_idx" ON "frame_versions" USING btree ("frame_id","saved_at");