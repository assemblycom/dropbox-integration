import type { FileSyncSelectType } from '@/db/schema/fileFolderSync.schema'
import type { DropboxFileListFolderSingleEntry } from '@/features/sync/types'

/** The fields of a synced file row the classifier needs. */
export type MappedFileRow = Pick<FileSyncSelectType, 'dbxFileId' | 'contentHash'>

export type DbxChangeClassification = {
  deleted: DropboxFileListFolderSingleEntry[]
  created: DropboxFileListFolderSingleEntry[]
  contentUpdated: DropboxFileListFolderSingleEntry[]
}

// Keep only the last entry per id, preserving order. Guards against a delta carrying
// duplicate ids in one bucket, which would otherwise fan out concurrent same-file syncs
// and double-create or trip the partial unique index. Applied per bucket so a rename's
// delete+create pair (same id, different buckets) is left intact.
const dedupeByIdKeepLast = (
  entries: DropboxFileListFolderSingleEntry[],
): DropboxFileListFolderSingleEntry[] => {
  const byId = new Map<string, DropboxFileListFolderSingleEntry>()
  for (const entry of entries) byId.set(entry.id, entry)
  return [...byId.values()]
}

/**
 * Splits Dropbox delta entries into deletes, creates, and content updates by comparing
 * them against the already-mapped rows. The caller must process `deleted` before `created`
 * so a rename (delete old id + create new id at the same path) does not violate the
 * partial unique index.
 */
export const classifyDbxChanges = (
  entries: DropboxFileListFolderSingleEntry[],
  mappedRows: MappedFileRow[],
): DbxChangeClassification => {
  // Set/Map lookups keep this linear when a cursor recovery feeds a full folder listing.
  // Caller queries with `dbxFileId IS NOT NULL`; drop any null defensively so ids stay strings.
  const contentHashById = new Map<string, string | null>()
  for (const row of mappedRows) {
    if (row.dbxFileId !== null) contentHashById.set(row.dbxFileId, row.contentHash)
  }
  const mappedIds = new Set(contentHashById.keys())

  const deleted = entries.filter((entry) => entry['.tag'] === 'deleted' && mappedIds.has(entry.id))
  const deletedIds = new Set(deleted.map((entry) => entry.id))

  // A create is a brand-new id, or the new-path half of a rename (its id also appears as a
  // delete in this batch, so it must be created at the new path). Deletes handled above.
  const created = entries.filter((entry) => {
    if (entry['.tag'] === 'deleted') return false
    const isNewId = !mappedIds.has(entry.id)
    const isNewPathOfRename = deletedIds.has(entry.id)
    return isNewId || isNewPathOfRename
  })
  const createdIds = new Set(created.map((entry) => entry.id))

  const contentUpdated = entries.filter((entry) => {
    if (entry['.tag'] === 'deleted' || createdIds.has(entry.id)) return false
    const existingHash = contentHashById.get(entry.id)
    return !!existingHash && existingHash !== entry.content_hash
  })

  return {
    deleted: dedupeByIdKeepLast(deleted),
    created: dedupeByIdKeepLast(created),
    contentUpdated: dedupeByIdKeepLast(contentUpdated),
  }
}
