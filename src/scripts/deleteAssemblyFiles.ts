/**
 * Delete duplicate files in Assembly, driven by the "Duplicate files in Assembly"
 * CSV (the "Duplicate assemblyId (Ids to DELETE)" column).
 *
 * For each (original, duplicate) pair, a duplicate is deleted in Assembly ONLY
 * IF its original assemblyId still resolves in Assembly AND is fully uploaded
 * (retrieveFile succeeds and status !== 'pending') — so we never remove the
 * last remaining copy of a file. A duplicate is also skipped when it is not a
 * file (folder / no file row) or still has a LIVE fileFolderSync row.
 *
 * Every Assembly call (the original-exists checks AND the deletes) goes through
 * copilotBottleneck (max 3 concurrent, 200ms apart => <=15 req/s, under
 * Assembly's 20 req/s cap).
 *
 * Dry-run by default — performs the read-only original-exists checks and prints
 * the deletion plan without deleting. Pass --execute to perform deletions.
 *
 *   pnpm ex "src/scripts/deleteAssemblyFiles.ts"                       # dry-run, default CSV
 *   pnpm ex "src/scripts/deleteAssemblyFiles.ts" --execute             # delete
 *   pnpm ex "src/scripts/deleteAssemblyFiles.ts" "path/to.csv" --execute
 */
import { resolve } from 'node:path'
import { inArray } from 'drizzle-orm'
import env from '@/config/server.env'
import { API_DOMAIN } from '@/constants/domains'
import db from '@/db'
import { ObjectType } from '@/db/constants'
import { type FileSyncSelectType, fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import { copilotBottleneck } from '@/lib/copilot/bottleneck'
import { CopilotAPI, isCopilotApiError } from '@/lib/copilot/CopilotAPI'
import { generateToken } from '@/lib/copilot/generateToken'
import { type DuplicateRecord, readDuplicateRecords } from '@/scripts/lib/duplicateFilesCsv'

const DEFAULT_CSV = 'Duplicate files in Assembly - assembly-keep-or-delete (1).csv'
const EXECUTE = process.argv.includes('--execute')

type Skip = { id: string; reason: string }
type PlannedDelete = {
  dupId: string
  originalId: string
  portalId: string
  path: string
  line: number
}

// Raw DELETE against the documented endpoint, bypassing the SDK (which targets
// the old api.copilot.app host and overwrites a shared global X-API-Key). The
// SDK authorizes as `${workspaceId}/${apiKey}`, so we replicate that header.
const deleteFileRaw = async (
  portalId: string,
  id: string,
): Promise<{ status: number; body: string }> => {
  const res = await fetch(`${API_DOMAIN}/v1/files/${id}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': `${portalId}/${env.COPILOT_API_KEY}` },
  })
  const body = await res.text().catch(() => '')
  return { status: res.status, body }
}

const main = async () => {
  const csvArg = process.argv.slice(2).find((a) => !a.startsWith('--'))
  const csvPath = resolve(process.cwd(), csvArg ?? DEFAULT_CSV)

  let records: DuplicateRecord[]
  try {
    records = readDuplicateRecords(csvPath)
  } catch {
    console.error(`Could not read CSV at: ${csvPath}`)
    process.exit(1)
  }

  console.info(`CSV: ${csvPath}`)
  console.info(`Mode: ${EXECUTE ? 'EXECUTE (will delete duplicates in Assembly)' : 'DRY-RUN'}`)
  console.info(`Records: ${records.length}`)
  console.info('Rate limit: throttled via copilotBottleneck (max 3 concurrent, <=15 req/s)\n')

  // Resolve the portal for each assemblyId from the DB — needed to mint a
  // workspace-scoped Copilot token.
  const allIds = [
    ...new Set(records.flatMap((rec) => [rec.originalId, ...rec.duplicates.map((d) => d.id)])),
  ].filter(Boolean)

  const rowsById = new Map<string, FileSyncSelectType[]>()
  if (allIds.length) {
    const rows = await db
      .select()
      .from(fileFolderSync)
      .where(inArray(fileFolderSync.assemblyFileId, allIds))
    for (const row of rows) {
      const key = row.assemblyFileId as string
      const list = rowsById.get(key) ?? []
      list.push(row)
      rowsById.set(key, list)
    }
  }

  const portalOf = (id: string) => rowsById.get(id)?.[0]?.portalId
  const hasLiveRow = (id: string) => (rowsById.get(id) ?? []).some((r) => r.deletedAt === null)
  // Only files are deletable. Authoritative source is the row's object column;
  // folders (and ids with no file row) are skipped.
  const isFile = (id: string) => (rowsById.get(id) ?? []).some((r) => r.object === ObjectType.FILE)

  // Per-record portal: prefer the original's, fall back to any duplicate's.
  const recordPortal = (rec: DuplicateRecord): string | undefined =>
    portalOf(rec.originalId) ?? rec.duplicates.map((d) => portalOf(d.id)).find(Boolean)

  // Lazily build one CopilotAPI per portal (null if no connection/initiatedBy).
  const copilotByPortal = new Map<string, CopilotAPI | null>()
  const getCopilot = async (portalId: string): Promise<CopilotAPI | null> => {
    const cached = copilotByPortal.get(portalId)
    if (cached !== undefined) return cached
    const connection = await db.query.dropboxConnections.findFirst({
      where: (c, { eq }) => eq(c.portalId, portalId),
    })
    const api = connection?.initiatedBy
      ? new CopilotAPI(
          generateToken(env.COPILOT_API_KEY, {
            workspaceId: portalId,
            // internalUserId: connection.initiatedBy,
          }),
        )
      : null
    copilotByPortal.set(portalId, api)
    return api
  }

  // 1. Confirm each unique original still resolves in Assembly (read-only).
  const originalPortal = new Map<string, string | undefined>()
  for (const rec of records) {
    if (!originalPortal.has(rec.originalId)) originalPortal.set(rec.originalId, recordPortal(rec))
  }

  // deletable=true only when the original resolves AND is fully uploaded
  // (status !== 'pending'); otherwise reason explains why its dups are kept.
  const originalStatus = new Map<string, { deletable: boolean; reason?: string }>()
  await Promise.all(
    [...originalPortal.entries()].map(([originalId, portalId]) =>
      (async () => {
        if (!portalId) {
          originalStatus.set(originalId, {
            deletable: false,
            reason: 'no portal resolved for original',
          })
          return
        }
        const copilot = await getCopilot(portalId)
        if (!copilot) {
          originalStatus.set(originalId, {
            deletable: false,
            reason: `no Copilot connection for portal ${portalId}`,
          })
          return
        }
        try {
          const file = await copilotBottleneck.schedule(() => copilot.retrieveFile(originalId))
          if (file.status === 'pending') {
            originalStatus.set(originalId, {
              deletable: false,
              reason: 'original is pending (not fully uploaded)',
            })
          } else {
            originalStatus.set(originalId, { deletable: true })
          }
        } catch (error) {
          if (isCopilotApiError(error) && error.status === 404) {
            originalStatus.set(originalId, {
              deletable: false,
              reason: 'original not found in Assembly (404)',
            })
          } else {
            const reason = error instanceof Error ? error.message : String(error)
            originalStatus.set(originalId, {
              deletable: false,
              reason: `original check failed: ${reason}`,
            })
          }
        }
      })(),
    ),
  )

  // 2. Build the deletion plan.
  const planned: PlannedDelete[] = []
  const skipped: Skip[] = []

  for (const rec of records) {
    if (rec.parseWarning) console.info(`  NOTE line ${rec.line}: ${rec.parseWarning}`)

    const portalId = recordPortal(rec)
    if (!portalId) {
      for (const dup of rec.duplicates) {
        skipped.push({ id: dup.id, reason: `no portal/connection resolved (line ${rec.line})` })
      }
      continue
    }

    const status = originalStatus.get(rec.originalId)
    if (!status?.deletable) {
      for (const dup of rec.duplicates) {
        skipped.push({
          id: dup.id,
          reason: `${status?.reason ?? 'original not deletable'} — keeping duplicate (line ${rec.line})`,
        })
      }
      continue
    }

    for (const dup of rec.duplicates) {
      if (!isFile(dup.id)) {
        skipped.push({
          id: dup.id,
          reason: `not a file (folder or no file row) — skipping (line ${rec.line})`,
        })
        continue
      }
      if (hasLiveRow(dup.id)) {
        skipped.push({
          id: dup.id,
          reason: `duplicate has a LIVE row — still mapped (line ${rec.line})`,
        })
        continue
      }
      planned.push({
        dupId: dup.id,
        originalId: rec.originalId,
        portalId,
        path: dup.path,
        line: rec.line,
      })
    }
  }

  console.info(`\nPlanned deletions: ${planned.length}`)
  console.info(`Skipped:           ${skipped.length}`)
  for (const s of skipped) console.info(`  SKIP ${s.id} — ${s.reason}`)

  if (!EXECUTE) {
    console.info('')
    for (const p of planned) {
      console.info(`  WOULD DELETE ${p.dupId} (line ${p.line}) — original present; "${p.path}"`)
    }
    console.info('\nDry-run complete. Re-run with --execute to delete in Assembly.')
    process.exit(0)
  }

  // 3. Delete (throttled, raw fetch).
  let deleted = 0
  let alreadyGone = 0
  const failed: Skip[] = []

  await Promise.all(
    planned.map((p) =>
      (async () => {
        try {
          const { status, body } = await copilotBottleneck.schedule(() =>
            deleteFileRaw(p.portalId, p.dupId),
          )
          if (status >= 200 && status < 300) {
            deleted++
            console.info(`  DELETED ${p.dupId} (line ${p.line}, portal ${p.portalId})`)
          } else if (status === 404) {
            alreadyGone++
            console.info(`  ALREADY GONE (404) ${p.dupId} (line ${p.line})`)
          } else {
            const reason = `status ${status}: ${body.slice(0, 300)}`
            failed.push({ id: p.dupId, reason })
            console.error(`  FAILED ${p.dupId} (line ${p.line}) — ${reason}`)
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          failed.push({ id: p.dupId, reason })
          console.error(`  FAILED ${p.dupId} (line ${p.line}) — ${reason}`)
        }
      })(),
    ),
  )

  console.info('\n=== Summary ===')
  console.info(`Deleted:      ${deleted}`)
  console.info(`Already gone: ${alreadyGone}`)
  console.info(`Skipped:      ${skipped.length}`)
  console.info(`Failed:       ${failed.length}`)
  for (const f of failed) console.info(`  FAIL ${f.id} — ${f.reason}`)

  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
