import { describe, expect, it } from 'vitest'
import { synthesizeDbxDeletes } from '@/features/webhook/dropbox/utils/synthesizeDbxDeletes'

const ROOT = '/moved-root'

describe('synthesizeDbxDeletes', () => {
  it('emits a deleted entry for a mapped file missing from the re-listing', () => {
    const listing = [{ id: 'dbx:kept', path_display: '/moved-root/kept.txt' }]
    const rows = [
      { dbxFileId: 'dbx:kept', itemPath: '/kept.txt' },
      { dbxFileId: 'dbx:gone', itemPath: '/sub/gone.txt' },
    ]

    const result = synthesizeDbxDeletes(listing, rows, ROOT)

    expect(result).toEqual([
      {
        '.tag': 'deleted',
        id: 'dbx:gone',
        name: 'gone.txt',
        // path_display rebuilt under the new root so getPathFromRoot recovers itemPath
        path_display: '/moved-root/sub/gone.txt',
      },
    ])
  })

  it('emits nothing when every mapped file is still present at its stored path', () => {
    const listing = [
      { id: 'dbx:a', path_display: '/moved-root/a.txt' },
      { id: 'dbx:b', path_display: '/moved-root/b.txt' },
    ]
    const rows = [
      { dbxFileId: 'dbx:a', itemPath: '/a.txt' },
      { dbxFileId: 'dbx:b', itemPath: '/b.txt' },
    ]

    expect(synthesizeDbxDeletes(listing, rows, ROOT)).toEqual([])
  })

  it('emits a delete at the old path for a file renamed to a new path under the same id', () => {
    // Same id, but the listing has it at a new path — a rename during the gap. The old-path
    // delete pairs with the listing entry so the file re-creates at its new path.
    const listing = [{ id: 'dbx:moved', path_display: '/moved-root/new-name.txt' }]
    const rows = [{ dbxFileId: 'dbx:moved', itemPath: '/old-name.txt' }]

    expect(synthesizeDbxDeletes(listing, rows, ROOT)).toEqual([
      {
        '.tag': 'deleted',
        id: 'dbx:moved',
        name: 'old-name.txt',
        path_display: '/moved-root/old-name.txt',
      },
    ])
  })

  it('emits nothing for a case-only path difference, matching the downstream lookup', () => {
    const listing = [{ id: 'dbx:c', path_display: '/moved-root/File.txt' }]
    const rows = [{ dbxFileId: 'dbx:c', itemPath: '/file.txt' }]

    expect(synthesizeDbxDeletes(listing, rows, ROOT)).toEqual([])
  })

  it('never treats an in-flight Assembly→Dropbox row (null dbxFileId) as a delete', () => {
    const listing: { id: string; path_display: string }[] = []
    const rows = [{ dbxFileId: null, itemPath: '/pushing-up.txt' }]

    expect(synthesizeDbxDeletes(listing, rows, ROOT)).toEqual([])
  })

  it('skips rows with no itemPath defensively', () => {
    const listing: { id: string; path_display: string }[] = []
    const rows = [{ dbxFileId: 'dbx:x', itemPath: null }]

    expect(synthesizeDbxDeletes(listing, rows, ROOT)).toEqual([])
  })
})
