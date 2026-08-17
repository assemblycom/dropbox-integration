import { describe, expect, it } from 'vitest'
import { pendingTotalCount, syncedPercentage } from '@/utils/sync-progress'

describe('syncedPercentage', () => {
  it('returns 100 when status is true, regardless of counts', () => {
    expect(syncedPercentage(true, 0, 0)).toBe(100)
    expect(syncedPercentage(true, 3, 7)).toBe(100)
  })

  it('returns 0 when status is false, regardless of counts', () => {
    expect(syncedPercentage(false, 7, 7)).toBe(0)
    expect(syncedPercentage(false, 3, 7)).toBe(0)
  })

  it('floors the synced/total ratio when status is null', () => {
    expect(syncedPercentage(null, 3, 7)).toBe(42)
  })

  it('caps the percentage at 100 when synced exceeds total', () => {
    expect(syncedPercentage(null, 9, 8)).toBe(100)
  })

  it('returns 0 when total is 0 (guards the divide-by-zero that yields NaN)', () => {
    expect(syncedPercentage(null, 0, 0)).toBe(0)
    expect(syncedPercentage(null, 5, 0)).toBe(0)
  })
})

describe('pendingTotalCount', () => {
  it('returns 0 for empty inputs', () => {
    expect(pendingTotalCount(0, [])).toBe(0)
  })

  it('sums the Dropbox count with non-pending Assembly files', () => {
    const assemblyFiles = [{ status: 'active' }, { status: 'active' }]
    expect(pendingTotalCount(3, assemblyFiles)).toBe(5)
  })

  it('excludes Assembly files with a pending status from the count', () => {
    const assemblyFiles = [{ status: 'pending' }, { status: 'active' }, { status: 'pending' }]
    expect(pendingTotalCount(2, assemblyFiles)).toBe(3)
  })

  it('returns the Dropbox count only when every Assembly file is pending', () => {
    const assemblyFiles = [{ status: 'pending' }, { status: 'pending' }]
    expect(pendingTotalCount(4, assemblyFiles)).toBe(4)
  })

  it('counts Assembly files with no status as non-pending', () => {
    const assemblyFiles = [{}, { status: 'pending' }]
    expect(pendingTotalCount(1, assemblyFiles)).toBe(2)
  })
})
