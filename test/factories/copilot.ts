import { Factory } from 'fishery'
import { ObjectType } from '@/db/constants'
import type { CopilotFileList, CopilotFileRetrieve } from '@/lib/copilot/types'
import { nextSeq, seqUuid } from './sequence'

export const copilotFileFactory = Factory.define<CopilotFileRetrieve>(({ params }) => {
  const n = nextSeq()
  const isFolder = params.object === ObjectType.FOLDER
  const name = isFolder ? `folder-${n}` : `file-${n}.txt`
  return {
    id: seqUuid(n),
    channelId: 'ch-1',
    name,
    object: params.object ?? ObjectType.FILE,
    path: `/${name}`,
  }
})

export const copilotFolderFactory = copilotFileFactory.params({ object: ObjectType.FOLDER })
export const copilotPendingFactory = copilotFileFactory.params({ status: 'pending' })
export const copilotDownloadableFactory = copilotFileFactory.params({
  downloadUrl: 'https://content.example/download',
})
export const copilotRenamedFactory = copilotFileFactory.params({
  previousAttributes: { name: 'previous-name.txt' },
})

// Wraps built files into the { data, nextToken? } page shape the Copilot list
// endpoint returns. Compose with the existing paginateCopilotListFiles MSW
// helper for multi-page listings.
export function copilotListPage(
  items: CopilotFileRetrieve[],
  opts: { nextToken?: string } = {},
): CopilotFileList {
  return opts.nextToken ? { data: items, nextToken: opts.nextToken } : { data: items }
}
