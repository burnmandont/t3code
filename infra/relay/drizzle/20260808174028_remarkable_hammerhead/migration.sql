CREATE TABLE "relay_apns_delivery_jobs" (
	"job_id" varchar(64) PRIMARY KEY,
	"body_json" jsonb NOT NULL,
	"state" varchar(16) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" varchar(64) NOT NULL,
	"claimed_at" varchar(64),
	"last_error_code" varchar(128),
	"created_at" varchar(64) NOT NULL,
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_relay_apns_delivery_jobs_available" ON "relay_apns_delivery_jobs" ("state","available_at","created_at");