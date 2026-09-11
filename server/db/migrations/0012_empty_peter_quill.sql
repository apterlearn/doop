ALTER TABLE "comments" ADD COLUMN "from_kind" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cancelled_at" bigint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cancelled_by" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "target_frame_ids" text;