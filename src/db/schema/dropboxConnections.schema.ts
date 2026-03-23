import { boolean, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core'
import { createInsertSchema, createSelectSchema, createUpdateSchema } from 'drizzle-zod'
import type z from 'zod'
import { timestamps } from '@/db/db.helpers'

export const dropboxConnections = pgTable(
  'dropbox_connections',
  {
    id: uuid().primaryKey().notNull().defaultRandom(),

    // Workspace ID / Portal ID in Copilot
    portalId: varchar({ length: 32 }).notNull(),

    // Unique account ID returned from DropboxAuth
    accountId: varchar({ length: 100 }),

    // refreshToken to refresh accessToken returned from DropboxAuth
    refreshToken: varchar({ length: 255 }),

    // Add this column
    rootNamespaceId: varchar({ length: 100 }),

    // Connection status
    status: boolean().notNull().default(false),

    // Flag to indicate a Dropbox webhook was deferred (debounced) and needs processing by cron
    pendingWebhook: boolean().default(false).notNull(),

    // Timestamp of last completed webhook-triggered sync for this account
    lastWebhookSyncedAt: timestamp({ withTimezone: true, mode: 'date' }),

    // Timestamp of when the last webhook sync started for this account
    lastWebhookSyncStartedAt: timestamp({ withTimezone: true, mode: 'date' }),

    // Copilot internalUserId that initiated the connection
    initiatedBy: uuid().notNull(),

    ...timestamps,
  },
  (table) => [uniqueIndex('uq_dropbox_connections_portal_id').on(table.portalId)],
)

export const DropboxConnectionSchema = createSelectSchema(dropboxConnections)
export type DropboxConnection = z.infer<typeof DropboxConnectionSchema>
// Authenticated dropbox connection (must have valid refreshToken + accountId)
export type DropboxConnectionTokens = {
  refreshToken: string
  accountId: string
  rootNamespaceId: string | null
}
export type DropboxConnectionWithTokens = DropboxConnection & DropboxConnectionTokens

export const DropboxConnectionInsertPayloadSchema = createInsertSchema(dropboxConnections)
export type DropboxConnectionInsertPayload = z.infer<typeof DropboxConnectionInsertPayloadSchema>

export const DropboxConnectionUpdatePayloadSchema = createUpdateSchema(dropboxConnections).omit({
  id: true,
  portalId: true,
})
export type DropboxConnectionUpdatePayload = z.infer<typeof DropboxConnectionUpdatePayloadSchema>
