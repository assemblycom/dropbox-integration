import { eq } from 'drizzle-orm'
import fetch from 'node-fetch'
import db from '@/db'
import { ObjectType } from '@/db/constants'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { CopilotAPI } from '@/lib/copilot/CopilotAPI'
import logger from '@/lib/logger'

const oldFolderName = '2026 FInancials'
const newFolderName = '2026 Financials'

function parseArgs() {
  // Usage: pnpm ex scripts/moveFileInAssembly.ts [--dry-run] <token> <id1> <id2> ...
  // ids may be passed as separate args and/or comma-separated.
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const [token, ...rest] = args.filter((arg) => arg !== '--dry-run')
  const fileFolderIds = [
    ...new Set(
      rest
        .flatMap((arg) => arg.split(','))
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ]

  if (!token || fileFolderIds.length === 0) {
    console.error(
      'Usage: pnpm ex scripts/moveFileInAssembly.ts [--dry-run] <token> <id1> <id2> ...',
    )
    process.exit(1)
  }

  return { token, fileFolderIds, dryRun }
}

/**
 * Replaces a whole path segment named `oldSegment` with `newSegment`.
 * Returns null if the segment isn't present, so callers can skip rather than
 * silently create a duplicate at the unchanged path.
 */
function movePathSegment(path: string, oldSegment: string, newSegment: string): string | null {
  const segments = path.split('/')
  const idx = segments.indexOf(oldSegment)
  if (idx === -1) {
    return null
  }
  segments[idx] = newSegment
  return segments.join('/')
}

async function main() {
  const { token, fileFolderIds, dryRun } = parseArgs()

  if (dryRun) {
    logger.info('Running in --dry-run mode: no files will be created, updated, or deleted.')
  }

  const assemblySdk = new CopilotAPI(token)

  let moved = 0
  let skipped = 0
  let failed = 0

  for (const fileId of fileFolderIds) {
    try {
      const record = await db.query.fileFolderSync.findFirst({
        where: (fileFolderSync, { eq }) => eq(fileFolderSync.id, fileId),
      })

      if (!record) {
        logger.info(`[${fileId}] skipped: record not found`)
        skipped++
        continue
      }

      if (record.object !== ObjectType.FILE) {
        logger.info(`[${fileId}] skipped: record is a ${record.object}, not a file`)
        skipped++
        continue
      }

      if (!record.assemblyFileId) {
        logger.info(`[${fileId}] skipped: record has no assemblyFileId`)
        skipped++
        continue
      }

      const channelSync = await db.query.channelSync.findFirst({
        where: (channelSync, { eq }) => eq(channelSync.id, record.channelSyncId),
      })
      if (!channelSync || !channelSync.assemblyChannelId) {
        logger.info(`[${fileId}] skipped: channelSync (or its assemblyChannelId) not found`)
        skipped++
        continue
      }

      const assemblyfile = await assemblySdk.retrieveFile(record.assemblyFileId)

      if (!assemblyfile.downloadUrl) {
        logger.info(`[${fileId}] skipped: assembly file has no downloadUrl`)
        skipped++
        continue
      }

      // move file from old folder to new folder
      // 1. replace the old folder segment with the new one to build the new path
      const newPath = movePathSegment(assemblyfile.path, oldFolderName, newFolderName)

      if (newPath === null) {
        logger.info(
          `[${fileId}] skipped: "${oldFolderName}" not found in path "${assemblyfile.path}"`,
        )
        skipped++
        continue
      }

      if (dryRun) {
        logger.info(`[${fileId}] [dry-run] would move: ${assemblyfile.path} -> ${newPath}`)
        skipped++
        continue
      }

      // 2. create the new file at the new path
      const newAssemblyFile = await assemblySdk.createFile(
        newPath,
        channelSync.assemblyChannelId,
        ObjectType.FILE,
      )

      if (!newAssemblyFile?.uploadUrl) {
        logger.info(`[${fileId}] skipped: new assembly file (or its uploadUrl) not created`)
        skipped++
        continue
      }

      try {
        // 3. download the old file and stream it into the new file. Verify both
        //    transfers succeeded before touching the DB or deleting the original.
        const downloadResp = await fetch(assemblyfile.downloadUrl)
        if (!downloadResp.ok) {
          throw new Error(`download failed with status ${downloadResp.status}`)
        }

        const contentLength = downloadResp.headers.get('content-length')
        if (contentLength == null) {
          throw new Error('download response missing content-length header')
        }

        const uploadResp = await assemblySdk.uploadFile(
          newAssemblyFile.uploadUrl,
          contentLength,
          downloadResp.body,
        )
        if (!uploadResp.ok) {
          throw new Error(`upload failed with status ${uploadResp.status}`)
        }

        logger.info(`[${fileId}] uploaded: ${assemblyfile.path} -> ${newPath}`)
      } catch (uploadError) {
        // Upload never completed — roll back the empty file we just created so we
        // don't leave an orphan, and leave the original untouched.
        logger.error(`[${fileId}] upload failed, rolling back new file ${newAssemblyFile.id}`)
        await assemblySdk.deleteFile(newAssemblyFile.id).catch((rollbackError) => {
          logger.error(
            `[${fileId}] rollback delete failed for ${newAssemblyFile.id}`,
            rollbackError,
          )
        })
        throw uploadError
      }

      // 4. point the record at the new file (only after the content is confirmed uploaded)
      await db
        .update(fileFolderSync)
        .set({
          assemblyFileId: newAssemblyFile.id,
          assemblyPath: newPath,
        })
        .where(eq(fileFolderSync.id, fileId))

      logger.info(`[${fileId}] db updated: assemblyFileId -> ${newAssemblyFile.id}`)

      // 5. finally delete the old file in assembly
      await assemblySdk.deleteFile(assemblyfile.id)
      logger.info(`[${fileId}] deleted old file ${assemblyfile.id} from assembly`)

      moved++
    } catch (error) {
      failed++
      logger.error(`[${fileId}] failed to move`, error)
    }
  }

  logger.info(
    `File move completed. moved=${moved}, skipped=${skipped}, failed=${failed}, total=${fileFolderIds.length} 🔥`,
  )
  process.exit(failed > 0 ? 1 : 0)
}

// biome-ignore lint/nursery/noFloatingPromises: floating promise is fine here
main()
