import { Column, SQL } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ObjectType, PendingAction, PendingActionTarget } from '@/db/constants'

// Capture the payload passed to .set() and the where condition for each call.
const setSpy = vi.fn()
const whereSpy = vi.fn()
const returningSpy = vi.fn()
// For .insert(...).values(...).onConflictDoNothing(...).returning()
const valuesSpy = vi.fn()
const onConflictSpy = vi.fn()
// Controls what the insert chain's .returning() resolves to, so tests can
// simulate both a successful insert and an onConflictDoNothing no-op (empty).
let insertReturning: unknown[] = [{ id: 'row-1' }]

vi.mock('@/db', () => {
  const builder = {
    set: (payload: unknown) => {
      setSpy(payload)
      return builder
    },
    where: (cond: unknown) => {
      whereSpy(cond)
      return builder
    },
    returning: () => {
      returningSpy()
      return Promise.resolve([{ id: 'row-1' }])
    },
  }
  const insertBuilder = {
    values: (payload: unknown) => {
      valuesSpy(payload)
      return insertBuilder
    },
    onConflictDoNothing: (opts: unknown) => {
      onConflictSpy(opts)
      return insertBuilder
    },
    returning: () => Promise.resolve(insertReturning),
  }
  return {
    default: {
      update: () => builder,
      insert: () => insertBuilder,
    },
  }
})

vi.mock('@/lib/dropbox/DropboxClient', () => ({
  DropboxClient: class {
    getDropboxClient() {
      return {}
    }
    dbxAuthClient = { refreshAccessToken: vi.fn() }
  },
}))

vi.mock('@/lib/copilot/CopilotAPI', () => ({
  CopilotAPI: class {},
  isCopilotApiError: () => false,
}))

import { MapFilesService } from '@/features/sync/lib/MapFiles.service'

const portalId = 'portal-xyz'
const user = { portalId, token: 't', copilot: {} } as never
const connectionToken = {
  accountId: 'a',
  refreshToken: 'r',
  rootNamespaceId: 'n',
} as never

let service: MapFilesService

beforeEach(() => {
  setSpy.mockClear()
  whereSpy.mockClear()
  returningSpy.mockClear()
  valuesSpy.mockClear()
  onConflictSpy.mockClear()
  insertReturning = [{ id: 'row-1' }]
  service = new MapFilesService(user, connectionToken)
})

/**
 * Walk a drizzle SQL fragment's queryChunks and concatenate the literal text
 * and column names that appear inside.
 *
 * Drizzle SQL fragments embed literal SQL in StringChunk objects shaped like
 * `{ value: string[] }` and column references as `Column` instances. Other
 * chunks (params, nested SQL) carry non-textual payloads or recurse, so we
 * cherry-pick string chunks + column names and recurse into nested fragments.
 *
 * Note on casing: `Column.name` holds the TS field name (e.g. `portalId`),
 * not the emitted DB column name (`portal_id`) — drizzle applies the
 * `casing: 'snake_case'` transform during query compilation, not on the
 * Column object itself. Tests that want to verify column scoping should use
 * a casing-tolerant regex (e.g. `/portal[_]?id/i`).
 *
 * Centralising this in one helper means that if drizzle restructures
 * `queryChunks`, only this function needs updating — every call site fails
 * loudly rather than silently degrading to a vacuous assertion.
 */
function sqlText(fragment: unknown): string {
  if (!(fragment instanceof SQL)) return ''
  const walk = (chunks: unknown[]): string[] => {
    const out: string[] = []
    for (const chunk of chunks) {
      if (chunk instanceof SQL) {
        out.push(...walk((chunk as unknown as { queryChunks: unknown[] }).queryChunks))
      } else if (chunk instanceof Column) {
        out.push(chunk.name)
      } else if (
        chunk &&
        typeof chunk === 'object' &&
        'value' in chunk &&
        Array.isArray((chunk as { value: unknown }).value)
      ) {
        out.push(...(chunk as { value: string[] }).value)
      }
    }
    return out
  }
  return walk((fragment as unknown as { queryChunks: unknown[] }).queryChunks).join(' ')
}

describe('markAttempt', () => {
  it('writes pending_action, pending_action_target, last_attempt_at, and a CASE-driven attempts expression in one statement', async () => {
    await service.markAttempt('row-1', PendingAction.DELETE, PendingActionTarget.ASSEMBLY)

    expect(setSpy).toHaveBeenCalledTimes(1)
    const payload = setSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload.pendingAction).toBe(PendingAction.DELETE)
    expect(payload.pendingActionTarget).toBe(PendingActionTarget.ASSEMBLY)
    expect(payload.pendingActionLastAttemptAt).toBeInstanceOf(Date)
    expect(payload.pendingActionLastError).toBeNull()

    // attempts is a SQL fragment, not a plain number — that's the CASE expression.
    expect(payload.pendingActionAttempts).not.toBeTypeOf('number')
    expect(payload.pendingActionAttempts).toBeInstanceOf(SQL)
    expect(sqlText(payload.pendingActionAttempts)).toMatch(/CASE/i)

    // WHERE must be scoped to the portal owning the row.
    expect(whereSpy).toHaveBeenCalledTimes(1)
    expect(sqlText(whereSpy.mock.calls[0][0])).toMatch(/portal[_]?id/i)
  })
})

describe('markDeleted', () => {
  it('soft-deletes the row and clears every pending_action* column in one statement', async () => {
    await service.markDeleted('row-1')

    expect(setSpy).toHaveBeenCalledTimes(1)
    const payload = setSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload.deletedAt).toBeInstanceOf(Date)
    expect(payload.pendingAction).toBeNull()
    expect(payload.pendingActionTarget).toBeNull()
    expect(payload.pendingActionAttempts).toBe(0)
    expect(payload.pendingActionLastAttemptAt).toBeNull()
    expect(payload.pendingActionLastError).toBeNull()

    // WHERE must be scoped to the portal owning the row.
    expect(whereSpy).toHaveBeenCalledTimes(1)
    expect(sqlText(whereSpy.mock.calls[0][0])).toMatch(/portal[_]?id/i)
  })
})

describe('markUpdated', () => {
  it('clears pending_action* and applies the caller-supplied target-side fields', async () => {
    await service.markUpdated('row-1', {
      contentHash: 'new-hash',
      assemblyFileId: '00000000-0000-0000-0000-000000000001',
      itemPath: '/folder/file.txt',
    })

    expect(setSpy).toHaveBeenCalledTimes(1)
    const payload = setSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload.contentHash).toBe('new-hash')
    expect(payload.assemblyFileId).toBe('00000000-0000-0000-0000-000000000001')
    expect(payload.itemPath).toBe('/folder/file.txt')
    expect(payload.pendingAction).toBeNull()
    expect(payload.pendingActionTarget).toBeNull()
    expect(payload.pendingActionAttempts).toBe(0)
    expect(payload.pendingActionLastAttemptAt).toBeNull()
    expect(payload.pendingActionLastError).toBeNull()
    // deletedAt must NOT be set on the update success path.
    expect(payload.deletedAt).toBeUndefined()

    // WHERE must be scoped to the portal owning the row.
    expect(whereSpy).toHaveBeenCalledTimes(1)
    expect(sqlText(whereSpy.mock.calls[0][0])).toMatch(/portal[_]?id/i)
  })
})

describe('insertFileMap', () => {
  const folderPayload = {
    portalId,
    channelSyncId: 'cs-1',
    itemPath: '/abc',
    object: ObjectType.FOLDER,
    assemblyFileId: '00000000-0000-0000-0000-000000000001',
    dbxFileId: null,
  }

  it('dedupes on (portal, channel, assemblyFileId) with the partial-index predicate', async () => {
    await service.insertFileMap(folderPayload)

    expect(onConflictSpy).toHaveBeenCalledTimes(1)
    const opts = onConflictSpy.mock.calls[0][0] as { target: unknown; where: unknown }

    // Conflict target must be the existing assembly unique index columns.
    const targetCols = (opts.target as unknown[]).map((c) => (c as { name: string }).name).join(' ')
    expect(targetCols).toMatch(/portal[_]?id/i)
    expect(targetCols).toMatch(/channel[_]?sync[_]?id/i)
    expect(targetCols).toMatch(/assembly[_]?file[_]?id/i)

    // WHERE must mirror the partial index predicate exactly.
    const where = sqlText(opts.where)
    expect(where).toMatch(/deleted[_]?at/i)
    expect(where).toMatch(/IS NULL/i)
    expect(where).toMatch(/assembly[_]?file[_]?id/i)
    expect(where).toMatch(/IS NOT NULL/i)
  })

  it('returns the inserted row when no conflict', async () => {
    insertReturning = [{ id: 'row-1' }]
    const result = await service.insertFileMap(folderPayload)
    expect(result).toEqual({ id: 'row-1' })
  })

  it('returns null when the row already exists (onConflictDoNothing no-op)', async () => {
    insertReturning = []
    const result = await service.insertFileMap(folderPayload)
    expect(result).toBeNull()
  })
})

describe('insertCreatePending', () => {
  it('stamps pendingActionLastAttemptAt = NOW() so the sweeper backoff guards in-flight rows', async () => {
    await service.insertCreatePending({
      channelSyncId: 'cs-1',
      itemPath: '/folder/file.txt',
      object: ObjectType.FILE,
      target: PendingActionTarget.ASSEMBLY,
      assemblyFileId: null,
      dbxFileId: 'd1',
    })

    expect(valuesSpy).toHaveBeenCalledTimes(1)
    const payload = valuesSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload.pendingAction).toBe(PendingAction.CREATE)
    expect(payload.pendingActionTarget).toBe(PendingActionTarget.ASSEMBLY)
    expect(payload.pendingActionLastAttemptAt).toBeInstanceOf(Date)
  })
})

describe('markFailure', () => {
  it('writes the error message and bumps the backoff window', async () => {
    await service.markFailure('row-1', 'kaboom')

    expect(setSpy).toHaveBeenCalledTimes(1)
    const payload = setSpy.mock.calls[0][0] as Record<string, unknown>
    expect(payload.pendingActionLastError).toBe('kaboom')
    expect(payload.pendingActionLastAttemptAt).toBeInstanceOf(Date)

    // WHERE must be scoped to the portal owning the row.
    expect(whereSpy).toHaveBeenCalledTimes(1)
    expect(sqlText(whereSpy.mock.calls[0][0])).toMatch(/portal[_]?id/i)
  })

  it('truncates the error to 500 chars to bound payload size', async () => {
    const long = 'x'.repeat(2000)
    await service.markFailure('row-1', long)
    const payload = setSpy.mock.calls[0][0] as Record<string, unknown>
    expect((payload.pendingActionLastError as string).length).toBe(500)
  })
})
