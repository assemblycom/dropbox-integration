CREATE TYPE "public"."pending_action_enum" AS ENUM('delete', 'create', 'update');
CREATE TYPE "public"."pending_action_target_enum" AS ENUM('assembly', 'dropbox');
ALTER TABLE "file_folder_sync" ADD COLUMN "pending_action" "pending_action_enum";
ALTER TABLE "file_folder_sync" ADD COLUMN "pending_action_target" "pending_action_target_enum";
ALTER TABLE "file_folder_sync" ADD COLUMN "pending_action_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "file_folder_sync" ADD COLUMN "pending_action_last_attempt_at" timestamp with time zone;
ALTER TABLE "file_folder_sync" ADD COLUMN "pending_action_last_error" text;
ALTER TABLE "file_folder_sync" ADD CONSTRAINT "file_folder_sync_pending_action_target_consistency" CHECK (("file_folder_sync"."pending_action" IS NULL) = ("file_folder_sync"."pending_action_target" IS NULL));