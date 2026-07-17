import { beforeEach, describe, expect, it } from 'vitest'
import { resetFactories, seqUuid } from './index'
import { nextSeq } from './sequence'

beforeEach(() => resetFactories())

describe('shared sequence', () => {
  it('increments from 1', () => {
    expect(nextSeq()).toBe(1)
    expect(nextSeq()).toBe(2)
  })

  it('resetFactories() zeroes the counter', () => {
    nextSeq()
    nextSeq()
    resetFactories()
    expect(nextSeq()).toBe(1)
  })

  it('seqUuid produces a valid, zero-padded uuid', () => {
    expect(seqUuid(1)).toBe('00000000-0000-4000-8000-000000000001')
    expect(seqUuid(42)).toBe('00000000-0000-4000-8000-000000000042')
  })
})
