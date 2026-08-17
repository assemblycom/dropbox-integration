/**
 * Sync progress arithmetic, kept pure so it can be unit tested without the DB or APIs.
 */

/** Percentage of files synced for a channel map. `status` short-circuits the count math. */
export const syncedPercentage = (
  status: boolean | null,
  syncedFilesCount: number,
  totalFilesCount: number,
): number => {
  switch (status) {
    case true:
      return 100
    case false:
      return 0
    default: {
      // Guard the divide-by-zero: no files means 0%, not NaN.
      if (totalFilesCount === 0) return 0
      const percentage = Math.floor((syncedFilesCount / totalFilesCount) * 100)
      return percentage > 100 ? 100 : percentage
    }
  }
}

/** Total files to sync: Dropbox count plus Assembly files that are not still pending. */
export const pendingTotalCount = (
  dbxFilesCount: number,
  assemblyFiles: { status?: string }[],
): number => {
  const nonPendingCount = assemblyFiles.filter((file) => file.status !== 'pending').length
  return dbxFilesCount + nonPendingCount
}
