ALTER TABLE "agent_plans" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "claimed_by_owner" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "claimed_by_owner" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "owner_id" text;