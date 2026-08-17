import type { FileSyncSelectType } from '@/db/schema/fileFolderSync.schema'
import type { DropboxFileListFolderSingleEntry } from '@/features/sync/types'

/** The fields of a synced file row the classifier needs. */
export type MappedFileRow = Pick<FileSyncSelectType, 'dbxFileId' | 'contentHash'>

export type DbxChangeClassification = {
  deleted: DropboxFileListFolderSingleEntry[]
  created: DropboxFileListFolderSingleEntry[]
  contentUpdated: DropboxFileListFolderSingleEntry[]
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
  // Caller queries with `dbxFileId IS NOT NULL`; drop any null defensively so ids stay strings.
  const mappedIds = mappedRows.map((row) => row.dbxFileId).filter((id): id is string => id !== null)

  const deleted = entries.filter(
    (entry) => entry['.tag'] === 'deleted' && mappedIds.includes(entry.id),
  )
  const deletedIds = deleted.map((entry) => entry.id)

  // Ids still mapped after removing the ones being deleted in this batch.
  const remainingIds = mappedIds.filter((id) => !deletedIds.includes(id))

  const created = entries.filter(
    (entry) => entry['.tag'] !== 'deleted' && !remainingIds.includes(entry.id),
  )
  const createdIds = created.map((entry) => entry.id)

  const contentUpdated = entries.filter((entry) => {
    if (entry['.tag'] === 'deleted' || createdIds.includes(entry.id)) return false
    const existing = mappedRows.find((row) => row.dbxFileId === entry.id)
    return !!existing?.contentHash && existing.contentHash !== entry.content_hash
  })

  return { deleted, created, contentUpdated }
}
