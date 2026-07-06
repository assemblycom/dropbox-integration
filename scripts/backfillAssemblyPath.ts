/**
 * ONE-TIME backfill for `file_folder_sync.assembly_path` (OUT-3918). Reads each
 * object's real path from Assembly (can't be recomputed from item_path) and stores it.
 * Read-only against Assembly. Run once per portal with that portal's Copilot token:
 *   pnpm ex scripts/backfillAssemblyPath.ts <copilotToken> <portalId>
 */
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import db from '@/db'
import { channelSync } from '@/db/schema/channelSync.schema'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { CopilotAPI } from '@/lib/copilot/CopilotAPI'
import { ensureLeadingSlash } from '@/utils/filePath'

// Rows per bulk UPDATE (2 params each, well under Postgres' parameter limit).
const CHUNK_SIZE = 500

// Update many rows in a single statement via UPDATE ... FROM (VALUES ...). Each
// statement is atomic; combined with the `assembly_path IS NULL` filter, an
// interrupted run is safe to just re-run (already-set rows are skipped).
async function bulkUpdateAssemblyPaths(updates: { id: string; assemblyPath: string }[]) {
  for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
    const chunk = updates.slice(i, i + CHUNK_SIZE)
    const values = sql.join(
      chunk.map((u) => sql`(${u.id}::uuid, ${u.assemblyPath}::varchar)`),
      sql`, `,
    )
    await db.execute(sql`
      UPDATE ${fileFolderSync} AS f
      SET assembly_path = v.assembly_path
      FROM (VALUES ${values}) AS v(id, assembly_path)
      WHERE f.id = v.id
    `)
  }
}

// assemblyFileId -> real Assembly path for one channel (listFiles returns folders too).
async function loadAssemblyPaths(
  copilot: CopilotAPI,
  assemblyChannelId: string,
): Promise<Map<string, string>> {
  const byId = new Map<string, string>()
  let nextToken: string | undefined

  do {
    const page = await copilot.listFiles(assemblyChannelId, nextToken)
    for (const item of page.data) byId.set(item.id, ensureLeadingSlash(item.path))
    nextToken = page.nextToken
  } while (nextToken)

  console.info(`  channel ${assemblyChannelId}: ${byId.size} objects`)
  return byId
}

async function main() {
  const [token, portalId] = process.argv.slice(2)
  if (!token || !portalId) {
    console.error('Usage: pnpm ex scripts/backfillAssemblyPath.ts <copilotToken> <portalId>')
    process.exit(1)
  }

  const copilot = new CopilotAPI(token)

  // Scope to the portal the token authorizes; run the script once per portal.
  const channels = await db.query.channelSync.findMany({
    where: and(eq(channelSync.portalId, portalId), isNull(channelSync.deletedAt)),
    columns: { id: true, assemblyChannelId: true, portalId: true },
  })
  console.info(
    `Backfilling assembly_path across ${channels.length} channels for portal ${portalId}`,
  )

  let updated = 0
  let missing = 0

  for (const channel of channels) {
    const pathById = await loadAssemblyPaths(copilot, channel.assemblyChannelId)

    // Only rows that were actually created in Assembly and not yet backfilled.
    const rows = await db.query.fileFolderSync.findMany({
      where: and(
        eq(fileFolderSync.channelSyncId, channel.id),
        eq(fileFolderSync.portalId, portalId),
        isNotNull(fileFolderSync.assemblyFileId),
        isNull(fileFolderSync.assemblyPath),
        isNull(fileFolderSync.deletedAt),
      ),
      columns: { id: true, assemblyFileId: true, itemPath: true },
    })

    const updates: { id: string; assemblyPath: string }[] = []
    for (const row of rows) {
      const assemblyFileId = row.assemblyFileId as string
      const realPath = pathById.get(assemblyFileId)

      if (!realPath) {
        missing++
        console.warn(`  no Assembly path for row ${row.id} (assemblyFileId=${assemblyFileId})`)
        continue
      }
      updates.push({ id: row.id, assemblyPath: realPath })
    }

    await bulkUpdateAssemblyPaths(updates)
    updated += updates.length
  }

  console.info(`Done. Updated ${updated} rows, ${missing} without a resolvable Assembly path.`)
  process.exit(0)
}

main().catch((error) => {
  console.error('backfillAssemblyPath failed', error)
  process.exit(1)
})
