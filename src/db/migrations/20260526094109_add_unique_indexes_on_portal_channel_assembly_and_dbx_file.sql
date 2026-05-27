-- Audit before deploy (Index 1):
-- SELECT portal_id, channel_sync_id, assembly_file_id, COUNT(*)
-- FROM file_folder_sync
-- WHERE deleted_at IS NULL AND assembly_file_id IS NOT NULL
-- GROUP BY 1, 2, 3 HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS "file_folder_sync_portal_channel_assembly_unique" ON "file_folder_sync" USING btree ("portal_id","channel_sync_id","assembly_file_id") WHERE "file_folder_sync"."deleted_at" IS NULL AND "file_folder_sync"."assembly_file_id" IS NOT NULL;

-- Audit before deploy (Index 2):
-- SELECT portal_id, channel_sync_id, dbx_file_id, COUNT(*)
-- FROM file_folder_sync
-- WHERE deleted_at IS NULL AND dbx_file_id IS NOT NULL
-- GROUP BY 1, 2, 3 HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS "file_folder_sync_portal_channel_dbx_unique" ON "file_folder_sync" USING btree ("portal_id","channel_sync_id","dbx_file_id") WHERE "file_folder_sync"."deleted_at" IS NULL AND "file_folder_sync"."dbx_file_id" IS NOT NULL;
