import { Factory } from 'fishery'
import type { DropboxFileListFolderSingleEntry } from '@/features/sync/types'
import { nextSeq } from './sequence'

// Default is a file entry with a content hash; the folder/deleted variants
// below preset `.tag`, and the generator branches on it (folders/deletes carry
// no content_hash — matching what the Dropbox API returns).
export const dropboxEntryFactory = Factory.define<DropboxFileListFolderSingleEntry>(
  ({ params }) => {
    const n = nextSeq()
    const tag = params['.tag'] ?? 'file'
    const isFolder = tag === 'folder'
    const name = isFolder ? `folder-${n}` : `file-${n}.txt`
    const entry: DropboxFileListFolderSingleEntry = {
      '.tag': tag,
      id: `dbx:${n}`,
      name,
      path_display: `/root/${name}`,
      ...(!isFolder && { is_downloadable: true }),
    }
    if (tag === 'file') entry.content_hash = `hash-${n}`
    return entry
  },
)

export const dropboxFolderFactory = dropboxEntryFactory.params({ '.tag': 'folder' })
export const dropboxDeletedFactory = dropboxEntryFactory.params({ '.tag': 'deleted' })
