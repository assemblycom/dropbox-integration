import { type InferInsertModel, type InferSelectModel, isNull, relations } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { createInsertSchema, createUpdateSchema } from 'drizzle-zod'
import type z from 'zod'
import { timestampsWithSoftDelete } from '@/db/db.helpers'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'

export const channelSync = pgTable(
  'channel_sync',
  {
    id: uuid().primaryKey().notNull().defaultRandom(),
    portalId: varchar({ length: 32 }).notNull(), // Workspace ID / Portal ID in Copilot
    dbxAccountId: varchar({ length: 100 }).notNull(),
    assemblyChannelId: varchar({ length: 255 }).notNull(), // Assembly channel ID
    dbxRootPath: varchar().notNull(),
    dbxRootId: varchar(),
    dbxCursor: varchar(),
    status: boolean().default(false), // Connection status
    // totalFilesCount and syncedFilesCount columns helps to calculate the progress of sync
    totalFilesCount: integer().default(0).notNull(),
    syncedFilesCount: integer().default(0).notNull(),
    lastSyncedAt: timestamp({ withTimezone: true, mode: 'date' }),
    // Set when the user clicks Resync; cleared by the orchestrator when the
    // bidirectional sync completes (or fails). Drives the "Resyncing..." UI
    // state so it survives a page refresh.
    resyncingAt: timestamp({ withTimezone: true, mode: 'date' }),
    ...timestampsWithSoftDelete,
  },
  (table) => [
    // Creating a combined index on portalId, dbxAccountId, deletedAt
    index('idx_channel_sync_portal_id_dbxAccount_id_deleted_at').on(
      table.portalId,
      table.dbxAccountId,
      table.deletedAt.nullsFirst(),
    ),
    uniqueIndex('uq_channel_sync__channel_id_dbx_root_path')
      .on(table.assemblyChannelId, table.dbxRootPath)
      .where(isNull(table.deletedAt)),
    index('idx_channel_sync_portal_id_deleted_at_created_at').on(
      table.portalId,
      table.createdAt.asc(),
      table.deletedAt.nullsFirst(),
    ),
  ],
)

export const ChannelSyncRelations = relations(channelSync, ({ many }) => ({
  fileSync: many(fileFolderSync),
}))

export const ChannelSyncCreateSchema = createInsertSchema(channelSync)
export type ChannelSyncCreateType = InferInsertModel<typeof channelSync>
export type ChannelSyncSelectType = InferSelectModel<typeof channelSync>

export const ChannelSyncUpdatePayloadSchema = createUpdateSchema(channelSync).omit({
  id: true,
  portalId: true,
  dbxAccountId: true,
})
export type ChannelSyncUpdatePayload = z.infer<typeof ChannelSyncUpdatePayloadSchema>
