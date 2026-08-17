import { describe, expect, it } from 'vitest'
import { getSyncedPercentage, pendingTotalCount } from '@/utils/sync-progress'

describe('getSyncedPercentage', () => {
  it('returns 100 when status is true, regardless of counts', () => {
    expect(getSyncedPercentage(true, 0, 0)).toBe(100)
    expect(getSyncedPercentage(true, 3, 7)).toBe(100)
  })

  it('returns 0 when status is false, regardless of counts', () => {
    expect(getSyncedPercentage(false, 7, 7)).toBe(0)
    expect(getSyncedPercentage(false, 3, 7)).toBe(0)
  })

  it('floors the synced/total ratio when status is null', () => {
    expect(getSyncedPercentage(null, 3, 7)).toBe(42)
  })

  it('caps the percentage at 100 when synced exceeds total', () => {
    expect(getSyncedPercentage(null, 9, 8)).toBe(100)
  })

  it('returns 0 when total is 0 (guards the divide-by-zero that yields NaN)', () => {
    expect(getSyncedPercentage(null, 0, 0)).toBe(0)
    expect(getSyncedPercentage(null, 5, 0)).toBe(0)
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
