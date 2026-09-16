CREATE TABLE "agent_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"author_name" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_color" text NOT NULL,
	"to" text,
	"body" text NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD COLUMN "agent_finish_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD COLUMN "agent_fail_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "agent_messages_canvas_idx" ON "agent_messages" USING btree ("canvas_id","at");