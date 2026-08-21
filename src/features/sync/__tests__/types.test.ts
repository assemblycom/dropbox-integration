import { describe, expect, it } from 'vitest'
import {
  FileSyncCreateRequestSchema,
  ResyncChannelRequestSchema,
  TotalFilesCountRequestSchema,
  UpdateConnectionStatusSchema,
} from '@/features/sync/types'

describe('FileSyncCreateRequestSchema', () => {
  it('accepts a fileChannelId and dbxRootPath', () => {
    expect(
      FileSyncCreateRequestSchema.safeParse({ fileChannelId: 'c', dbxRootPath: '/r' }).success,
    ).toBe(true)
  })

  it('rejects a payload missing a field', () => {
    expect(FileSyncCreateRequestSchema.safeParse({ fileChannelId: 'c' }).success).toBe(false)
  })
})

describe('ResyncChannelRequestSchema', () => {
  it('accepts a uuid channelSyncId', () => {
    expect(
      ResyncChannelRequestSchema.safeParse({
        channelSyncId: '00000000-0000-4000-8000-000000000000',
      }).success,
    ).toBe(true)
  })

  it('rejects a non-uuid channelSyncId', () => {
    expect(ResyncChannelRequestSchema.safeParse({ channelSyncId: 'not-a-uuid' }).success).toBe(
      false,
    )
  })
})

describe('UpdateConnectionStatusSchema', () => {
  it('accepts a boolean status with non-empty ids', () => {
    expect(
      UpdateConnectionStatusSchema.safeParse({
        status: true,
        assemblyChannelId: 'ch',
        dbxRootPath: '/r',
      }).success,
    ).toBe(true)
  })

  it('rejects an empty assemblyChannelId', () => {
    expect(
      UpdateConnectionStatusSchema.safeParse({
        status: true,
        assemblyChannelId: '',
        dbxRootPath: '/r',
      }).success,
    ).toBe(false)
  })

  it('rejects a non-boolean status', () => {
    expect(
      UpdateConnectionStatusSchema.safeParse({
        status: 'yes',
        assemblyChannelId: 'ch',
        dbxRootPath: '/r',
      }).success,
    ).toBe(false)
  })
})

describe('TotalFilesCountRequestSchema', () => {
  it('accepts required ids, with limit optional', () => {
    expect(
      TotalFilesCountRequestSchema.safeParse({ assemblyChannelId: 'ch', dbxRootPath: '/r' })
        .success,
    ).toBe(true)
    expect(
      TotalFilesCountRequestSchema.safeParse({
        assemblyChannelId: 'ch',
        dbxRootPath: '/r',
        limit: '10',
      }).success,
    ).toBe(true)
  })

  it('rejects an empty limit string when provided', () => {
    expect(
      TotalFilesCountRequestSchema.safeParse({
        assemblyChannelId: 'ch',
        dbxRootPath: '/r',
        limit: '',
      }).success,
    ).toBe(false)
  })
})
