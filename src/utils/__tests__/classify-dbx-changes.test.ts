import { describe, expect, it } from 'vitest'
import type { DropboxFileListFolderSingleEntry } from '@/features/sync/types'
import { classifyDbxChanges, type MappedFileRow } from '@/utils/classify-dbx-changes'

const makeEntry = (
  overrides: Partial<DropboxFileListFolderSingleEntry> & { id: string },
): DropboxFileListFolderSingleEntry => ({
  '.tag': 'file',
  name: 'file.txt',
  path_display: `/folder/${overrides.id}.txt`,
  ...overrides,
})

const makeRow = (dbxFileId: string, contentHash: string | null = null): MappedFileRow => ({
  dbxFileId,
  contentHash,
})

const ids = (entries: DropboxFileListFolderSingleEntry[]) => entries.map((entry) => entry.id)

describe('classifyDbxChanges', () => {
  it('keys off the entry id, not the path or name', () => {
    // Name differs from what was stored, but the id matches a mapped row,
    // so the entry is recognised as existing (not new) and its hash is unchanged.
    const entries = [makeEntry({ id: 'abc', name: 'renamed.txt', content_hash: 'hash-1' })]
    const rows = [makeRow('abc', 'hash-1')]

    const result = classifyDbxChanges(entries, rows)

    expect(ids(result.deleted)).toEqual([])
    expect(ids(result.created)).toEqual([])
    expect(ids(result.contentUpdated)).toEqual([])
  })

  it('classifies deleted entries whose id is mapped', () => {
    const entries = [makeEntry({ id: 'gone', '.tag': 'deleted' })]
    const rows = [makeRow('gone')]

    const result = classifyDbxChanges(entries, rows)

    expect(ids(result.deleted)).toEqual(['gone'])
    expect(ids(result.created)).toEqual([])
  })

  it('ignores deleted entries whose id is not mapped', () => {
    const entries = [makeEntry({ id: 'never-synced', '.tag': 'deleted' })]

    const result = classifyDbxChanges(entries, [])

    expect(ids(result.deleted)).toEqual([])
    expect(ids(result.created)).toEqual([])
  })

  it('classifies non-deleted entries not in the mapped set as new', () => {
    const entries = [makeEntry({ id: 'fresh' })]

    const result = classifyDbxChanges(entries, [])

    expect(ids(result.created)).toEqual(['fresh'])
    expect(ids(result.deleted)).toEqual([])
  })

  it('treats a re-created id that was just deleted as new (mapped minus deleted)', () => {
    // A delete + create of the same id in one batch: it must still count as new.
    const entries = [
      makeEntry({ id: 'x', '.tag': 'deleted' }),
      makeEntry({ id: 'x', '.tag': 'file' }),
    ]
    const rows = [makeRow('x')]

    const result = classifyDbxChanges(entries, rows)

    expect(ids(result.deleted)).toEqual(['x'])
    expect(ids(result.created)).toEqual(['x'])
  })

  it('separates a rename into a delete and a create so the caller can delete first', () => {
    // Rename = delete old id + create new id at the same path.
    const entries = [
      makeEntry({ id: 'old', '.tag': 'deleted', path_display: '/folder/name.txt' }),
      makeEntry({ id: 'new', '.tag': 'file', path_display: '/folder/name.txt' }),
    ]
    const rows = [makeRow('old', 'hash-1')]

    const result = classifyDbxChanges(entries, rows)

    expect(ids(result.deleted)).toEqual(['old'])
    expect(ids(result.created)).toEqual(['new'])
    expect(ids(result.contentUpdated)).toEqual([])
  })

  it('classifies a content update when the stored hash differs from the entry hash', () => {
    const entries = [makeEntry({ id: 'doc', content_hash: 'hash-2' })]
    const rows = [makeRow('doc', 'hash-1')]

    const result = classifyDbxChanges(entries, rows)

    expect(ids(result.contentUpdated)).toEqual(['doc'])
    expect(ids(result.created)).toEqual([])
    expect(ids(result.deleted)).toEqual([])
  })

  it('does not classify a content update when the hashes are equal', () => {
    const entries = [makeEntry({ id: 'doc', content_hash: 'same' })]
    const rows = [makeRow('doc', 'same')]

    const result = classifyDbxChanges(entries, rows)

    expect(ids(result.contentUpdated)).toEqual([])
  })

  it('does not classify a content update when the stored hash is null', () => {
    const entries = [makeEntry({ id: 'doc', content_hash: 'hash-2' })]
    const rows = [makeRow('doc', null)]

    const result = classifyDbxChanges(entries, rows)

    expect(ids(result.contentUpdated)).toEqual([])
  })

  it('classifies a mixed batch of delete, create, and content update independently', () => {
    const entries = [
      makeEntry({ id: 'del', '.tag': 'deleted' }),
      makeEntry({ id: 'add', '.tag': 'file' }),
      makeEntry({ id: 'upd', content_hash: 'new-hash' }),
      makeEntry({ id: 'same', content_hash: 'unchanged' }),
    ]
    const rows = [makeRow('del'), makeRow('upd', 'old-hash'), makeRow('same', 'unchanged')]

    const result = classifyDbxChanges(entries, rows)

    expect(ids(result.deleted)).toEqual(['del'])
    expect(ids(result.created)).toEqual(['add'])
    expect(ids(result.contentUpdated)).toEqual(['upd'])
  })

  it('dedupes duplicate ids within a bucket, keeping the last occurrence', () => {
    const entries = [
      makeEntry({ id: 'dup', content_hash: 'new-1' }),
      makeEntry({ id: 'dup', content_hash: 'new-2' }),
    ]
    const rows = [makeRow('dup', 'old')]

    const result = classifyDbxChanges(entries, rows)

    expect(ids(result.contentUpdated)).toEqual(['dup'])
    expect(result.contentUpdated[0].content_hash).toBe('new-2')
  })

  it('keeps a rename pair intact (same id in delete and create buckets)', () => {
    const entries = [
      makeEntry({ id: 'x', '.tag': 'deleted' }),
      makeEntry({ id: 'x', '.tag': 'file', path_display: '/folder/renamed.txt' }),
    ]
    const rows = [makeRow('x')]

    const result = classifyDbxChanges(entries, rows)

    expect(ids(result.deleted)).toEqual(['x'])
    expect(ids(result.created)).toEqual(['x'])
  })

  it('dedupes duplicate ids within the created bucket', () => {
    const entries = [
      makeEntry({ id: 'new', path_display: '/folder/a.txt' }),
      makeEntry({ id: 'new', path_display: '/folder/b.txt' }),
    ]

    const result = classifyDbxChanges(entries, [])

    expect(ids(result.created)).toEqual(['new'])
    expect(result.created[0].path_display).toBe('/folder/b.txt')
  })

  it('dedupes duplicate ids within the deleted bucket', () => {
    const entries = [
      makeEntry({ id: 'gone', '.tag': 'deleted' }),
      makeEntry({ id: 'gone', '.tag': 'deleted' }),
    ]
    const rows = [makeRow('gone')]

    const result = classifyDbxChanges(entries, rows)

    expect(ids(result.deleted)).toEqual(['gone'])
  })
})
