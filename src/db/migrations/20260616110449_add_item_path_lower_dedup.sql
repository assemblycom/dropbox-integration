ALTER TABLE "file_folder_sync" ADD COLUMN "item_path_lower" varchar GENERATED ALWAYS AS (lower("file_folder_sync"."item_path")) STORED;
CREATE UNIQUE INDEX "file_folder_sync_portal_channel_path_unique" ON "file_folder_sync" USING btree ("portal_id","channel_sync_id","item_path_lower") WHERE "file_folder_sync"."deleted_at" IS NULL AND "file_folder_sync"."item_path" IS NOT NULL;
