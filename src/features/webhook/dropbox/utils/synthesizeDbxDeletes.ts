import type { FileSyncSelectType } from '@/db/schema/fileFolderSync.schema'
import type { DropboxFileListFolderSingleEntry } from '@/features/sync/types'
import { getPathFromRoot } from '@/utils/filePath'

type DeleteCandidateRow = Pick<FileSyncSelectType, 'dbxFileId' | 'itemPath'>

// A recovery re-lists the folder, but a listing has no delete markers. Synthesize them for
// mapped rows gone from the listing (removed) or now at a new path (renamed — the old-path
// delete pairs with the listing's new-path entry). Null dbxFileId rows are in-flight
// Assembly→Dropbox files, never deletes.
export function synthesizeDbxDeletes(
  listing: Pick<DropboxFileListFolderSingleEntry, 'id' | 'path_display'>[],
  mappedRows: DeleteCandidateRow[],
  rootPath: string,
): DropboxFileListFolderSingleEntry[] {
  const listedPathById = new Map(listing.map((entry) => [entry.id, entry.path_display]))

  return mappedRows.flatMap((row) => {
    if (!row.dbxFileId || !row.itemPath) return []

    // Case-insensitive like the downstream lookup, so a case-only change isn't churned.
    const listedPath = listedPathById.get(row.dbxFileId)
    const stillAtStoredPath =
      listedPath !== undefined &&
      getPathFromRoot(listedPath, rootPath).toLowerCase() === row.itemPath.toLowerCase()
    if (stillAtStoredPath) return []

    return [
      {
        '.tag': 'deleted',
        id: row.dbxFileId,
        name: row.itemPath.split('/').filter(Boolean).pop() ?? row.itemPath,
        // Rebuild under the new root so getPathFromRoot yields the stored itemPath.
        path_display: `${rootPath}${row.itemPath}`,
      },
    ]
  })
}
