ALTER TABLE "frames" ADD COLUMN "z" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "rotation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "frames" ADD COLUMN "opacity" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "frames" SET "z" = sub.rn - 1 FROM (SELECT id, row_number() OVER (PARTITION BY canvas_id ORDER BY created_at, id) AS rn FROM "frames") sub WHERE "frames"."id" = sub."id";