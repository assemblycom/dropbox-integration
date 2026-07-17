import { eq, type InferSelectModel } from 'drizzle-orm'
import { Factory } from 'fishery'
import db from '@/db'
import { ObjectType, PendingAction, type PendingActionTargetValue } from '@/db/constants'
import { channelSync } from '@/db/schema/channelSync.schema'
import { type FileSyncCreateType, fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import type { DropboxFileListFolderSingleEntry } from '@/features/sync/types'
import { nextSeq, seqUuid } from '../factories/sequence'
import { channelSeeder } from './channel'

type FileRow = InferSelectModel<typeof fileFolderSync>

// portalId/channelSyncId optional at the seed layer: omit them to auto-create
// the parent channel (which auto-creates a connection).
export type FileSeed = Omit<FileSyncCreateType, 'portalId' | 'channelSyncId'> & {
  portalId?: string
  channelSyncId?: string
}

export const fileSyncSeeder = Factory.define<FileSeed, Record<string, never>, FileRow>(
  ({ onCreate }) => {
    const n = nextSeq()
    onCreate(async (values) => {
      const { portalId: pid, channelSyncId: cid, ...rest } = values
      let portalId = pid
      let channelSyncId = cid
      if (!channelSyncId) {
        const channel = await channelSeeder.create(portalId ? { portalId } : {})
        channelSyncId = channel.id
        portalId = portalId ?? channel.portalId
      } else if (!portalId) {
        const [ch] = await db
          .select({ portalId: channelSync.portalId })
          .from(channelSync)
          .where(eq(channelSync.id, channelSyncId))
        if (!ch) throw new Error(`fileSyncSeeder: channelSync ${channelSyncId} not found`)
        portalId = ch.portalId
      }
      const [row] = await db
        .insert(fileFolderSync)
        .values({ ...rest, portalId, channelSyncId })
        .returning()
      return row
    })
    return {
      itemPath: `/root/file-${n}.txt`,
      object: ObjectType.FILE,
    }
  },
)

// --- Traits: partial overrides passed into .create(). Each keeps the
// pending_action_target_consistency CHECK satisfied (action+target together). ---

export function pendingCreate(target: PendingActionTargetValue): Partial<FileSeed> {
  return {
    pendingAction: PendingAction.CREATE,
    pendingActionTarget: target,
    pendingActionAttempts: 1,
    pendingActionLastAttemptAt: new Date(),
  }
}

export function pendingDelete(target: PendingActionTargetValue): Partial<FileSeed> {
  return {
    pendingAction: PendingAction.DELETE,
    pendingActionTarget: target,
    pendingActionAttempts: 1,
    pendingActionLastAttemptAt: new Date(),
  }
}

export function tombstone(): Partial<FileSeed> {
  return { deletedAt: new Date() }
}

// The Assembly side of a fully-synced row. Compose with fromDropboxEntry for the
// Dropbox side: fileSyncSeeder.create(fromDropboxEntry(entry, synced())).
export function synced(overrides: Partial<FileSeed> = {}): Partial<FileSeed> {
  const n = nextSeq()
  return {
    assemblyFileId: seqUuid(n),
    assemblyPath: `/root/file-${n}.txt`,
    ...overrides,
  }
}

// Derive DB fields from a Dropbox entry factory result so a seeded row and the
// remote fixture it represents cannot disagree on id / path / hash.
export function fromDropboxEntry(
  entry: DropboxFileListFolderSingleEntry,
  overrides: Partial<FileSeed> = {},
): Partial<FileSeed> {
  return {
    itemPath: entry.path_display,
    dbxFileId: entry.id,
    contentHash: entry.content_hash ?? null,
    object: entry['.tag'] === 'folder' ? ObjectType.FOLDER : ObjectType.FILE,
    ...overrides,
  }
}
