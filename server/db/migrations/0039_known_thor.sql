CREATE TABLE "agent_events" (
	"canvas_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"kind" text NOT NULL,
	"at" bigint NOT NULL,
	"summary" text,
	"target_agent" text
);
--> statement-breakpoint
CREATE TABLE "agent_signals" (
	"canvas_id" text NOT NULL,
	"target" text NOT NULL,
	"kind" text NOT NULL,
	"message" text,
	"by" text NOT NULL,
	"at" bigint NOT NULL,
	"taken_at" bigint
);
--> statement-breakpoint
CREATE INDEX "agent_events_canvas_seq_idx" ON "agent_events" USING btree ("canvas_id","seq");--> statement-breakpoint
CREATE INDEX "agent_signals_canvas_target_idx" ON "agent_signals" USING btree ("canvas_id","target");