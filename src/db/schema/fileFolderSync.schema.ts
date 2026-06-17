import { type InferInsertModel, type InferSelectModel, relations, type SQL, sql } from 'drizzle-orm'
import {
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { createInsertSchema, createUpdateSchema } from 'drizzle-zod'
import type z from 'zod'
import { ObjectType, PendingAction, PendingActionTarget } from '@/db/constants'
import { enumToPgEnum, timestampsWithSoftDelete } from '@/db/db.helpers'
import { channelSync } from '@/db/schema/channelSync.schema'

export const ObjectEnum = pgEnum('object_types', enumToPgEnum(ObjectType))
export const PendingActionEnum = pgEnum('pending_action_enum', enumToPgEnum(PendingAction))
export const PendingActionTargetEnum = pgEnum(
  'pending_action_target_enum',
  enumToPgEnum(PendingActionTarget),
)

export const fileFolderSync = pgTable(
  'file_folder_sync',
  {
    id: uuid().primaryKey().notNull().defaultRandom(),
    portalId: varchar({ length: 32 }).notNull(), // Workspace ID / Portal ID in Copilot
    channelSyncId: uuid()
      .notNull()
      .references(() => channelSync.id, {
        onDelete: 'cascade',
        onUpdate: 'cascade',
      }),
    itemPath: varchar(),
    // Read-only lower(item_path) mirror: gives the case-insensitive path index a
    // real column to target (drizzle's onConflict rejects expressions).
    itemPathLower: varchar().generatedAlwaysAs((): SQL => sql`lower(${fileFolderSync.itemPath})`),
    object: ObjectEnum().default(ObjectType.FILE).notNull(),
    contentHash: varchar(),
    dbxFileId: varchar(),
    assemblyFileId: uuid(),
    pendingAction: PendingActionEnum(),
    pendingActionTarget: PendingActionTargetEnum(),
    pendingActionAttempts: integer().notNull().default(0),
    pendingActionLastAttemptAt: timestamp({ withTimezone: true, mode: 'date' }),
    pendingActionLastError: text(),
    ...timestampsWithSoftDelete,
  },
  (table) => [
    check(
      'file_folder_sync_pending_action_target_consistency',
      sql`(${table.pendingAction} IS NULL) = (${table.pendingActionTarget} IS NULL)`,
    ),
    // Inserts dedupe on the path index; any ON CONFLICT must repeat the targeted
    // index's partial predicate exactly or Postgres rejects it.
    uniqueIndex('file_folder_sync_portal_channel_assembly_unique')
      .on(table.portalId, table.channelSyncId, table.assemblyFileId)
      .where(sql`${table.deletedAt} IS NULL AND ${table.assemblyFileId} IS NOT NULL`),
    uniqueIndex('file_folder_sync_portal_channel_dbx_unique')
      .on(table.portalId, table.channelSyncId, table.dbxFileId)
      .where(sql`${table.deletedAt} IS NULL AND ${table.dbxFileId} IS NOT NULL`),
    uniqueIndex('file_folder_sync_portal_channel_path_unique')
      .on(table.portalId, table.channelSyncId, table.itemPathLower)
      .where(sql`${table.deletedAt} IS NULL AND ${table.itemPath} IS NOT NULL`),
  ],
)

export const FileSyncRelations = relations(fileFolderSync, ({ one }) => ({
  channel: one(channelSync, {
    fields: [fileFolderSync.channelSyncId],
    references: [channelSync.id],
  }),
}))

export const FileFolderCreateSchema = createInsertSchema(fileFolderSync)
export type FileSyncCreateType = InferInsertModel<typeof fileFolderSync>
export type FileSyncSelectType = InferSelectModel<typeof fileFolderSync>

export const FileSyncUpdatePayloadSchema = createUpdateSchema(fileFolderSync).omit({
  id: true,
  portalId: true,
  channelSyncId: true,
})
export type FileSyncUpdatePayload = z.infer<typeof FileSyncUpdatePayloadSchema>
