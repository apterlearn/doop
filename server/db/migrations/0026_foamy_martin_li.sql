ALTER TABLE "run_journals" ADD COLUMN "started_at" bigint;--> statement-breakpoint
ALTER TABLE "run_journals" ADD COLUMN "ended_at" bigint;--> statement-breakpoint
ALTER TABLE "run_journals" ADD COLUMN "turns" integer;--> statement-breakpoint
ALTER TABLE "run_journals" ADD COLUMN "tool_calls" integer;--> statement-breakpoint
ALTER TABLE "run_journals" ADD COLUMN "tokens" integer;--> statement-breakpoint
ALTER TABLE "run_journals" ADD COLUMN "cost_usd" double precision;