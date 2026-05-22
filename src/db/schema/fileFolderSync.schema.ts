import { type InferInsertModel, type InferSelectModel, relations, sql } from 'drizzle-orm'
import {
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
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
