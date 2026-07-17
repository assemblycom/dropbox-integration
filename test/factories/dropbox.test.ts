import { beforeEach, describe, expect, it } from 'vitest'
import { DropboxFileListFolderSingleEntrySchema } from '@/features/sync/types'
import { dropboxDeletedFactory, dropboxEntryFactory, dropboxFolderFactory } from './dropbox'
import { resetFactories } from './index'

beforeEach(() => resetFactories())

describe('dropboxEntryFactory', () => {
  it('produces a schema-valid file entry with a content hash', () => {
    const entry = dropboxEntryFactory.build()
    expect(DropboxFileListFolderSingleEntrySchema.parse(entry)).toEqual(entry)
    expect(entry['.tag']).toBe('file')
    expect(entry.id).toBe('dbx:1')
    expect(entry.content_hash).toBeDefined()
    expect(entry.is_downloadable).toBeTruthy()
  })

  it('folder trait sets .tag=folder and drops the content hash', () => {
    const folder = dropboxFolderFactory.build()
    expect(folder['.tag']).toBe('folder')
    expect(folder.content_hash).toBeUndefined()
    expect(folder.is_downloadable).toBeUndefined()
  })

  it('deleted trait sets .tag=deleted', () => {
    expect(dropboxDeletedFactory.build()['.tag']).toBe('deleted')
  })

  it('respects explicit overrides', () => {
    const entry = dropboxEntryFactory.build({ path_display: '/root/custom.txt' })
    expect(entry.path_display).toBe('/root/custom.txt')
    expect(entry.id).toBe('dbx:1')
  })

  it('sequences ids across builds', () => {
    expect(dropboxEntryFactory.build().id).toBe('dbx:1')
    expect(dropboxEntryFactory.build().id).toBe('dbx:2')
  })
})
