CREATE TABLE "agent_levels" (
	"canvas_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"level" text NOT NULL,
	"set_by" text NOT NULL,
	"set_at" bigint NOT NULL,
	CONSTRAINT "agent_levels_canvas_id_agent_id_pk" PRIMARY KEY("canvas_id","agent_id")
);
