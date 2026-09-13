ALTER TABLE "agent_questions" ADD COLUMN "choices" jsonb;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "multi" boolean;--> statement-breakpoint
ALTER TABLE "agent_questions" ADD COLUMN "allow_other" boolean;--> statement-breakpoint
ALTER TABLE "frame_proposals" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "run_journals" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "run_journals" ADD COLUMN "frames" jsonb;