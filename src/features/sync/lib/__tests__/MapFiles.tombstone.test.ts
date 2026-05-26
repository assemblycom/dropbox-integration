import { Column, SQL } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PendingAction, PendingActionTarget } from '@/db/constants'

// Capture the payload passed to .set() and the where condition for each call.
const setSpy = vi.fn()
const whereSpy = vi.fn()
const returningSpy = vi.fn()

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
  return {
    default: {
      update: () => builder,
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
