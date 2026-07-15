import { type HttpHandler, HttpResponse, http } from 'msw'
import { COPILOT_HOST, DROPBOX_RPC_HOST } from './hosts'

// Each paginator tracks only the offset (from the cursor / nextToken), so one
// registration fakes one listing per test. Concurrent listings need separate ones.

// Caller passes entries; this owns the cursor/has_more protocol.
export function paginateDropboxListFolder(
  entries: unknown[],
  { pageSize = 100 }: { pageSize?: number } = {},
): HttpHandler[] {
  const page = (offset: number) => {
    const slice = entries.slice(offset, offset + pageSize)
    const nextOffset = offset + slice.length
    return { entries: slice, cursor: `cursor:${nextOffset}`, has_more: nextOffset < entries.length }
  }
  return [
    http.post(`${DROPBOX_RPC_HOST}/2/files/list_folder`, () => HttpResponse.json(page(0))),
    http.post(`${DROPBOX_RPC_HOST}/2/files/list_folder/continue`, async ({ request }) => {
      const { cursor } = (await request.json()) as { cursor: string }
      const offset = Number(cursor.split(':')[1] ?? 0)
      return HttpResponse.json(page(offset))
    }),
  ]
}

// Caller passes items; paginates via nextToken.
export function paginateCopilotListFiles(
  items: unknown[],
  { pageSize = 100 }: { pageSize?: number } = {},
): HttpHandler {
  return http.get(`${COPILOT_HOST}/v1/files`, ({ request }) => {
    const token = new URL(request.url).searchParams.get('nextToken')
    const offset = token ? Number(token.split(':')[1] ?? 0) : 0
    const slice = items.slice(offset, offset + pageSize)
    const nextOffset = offset + slice.length
    const nextToken = nextOffset < items.length ? `token:${nextOffset}` : undefined
    return HttpResponse.json({ data: slice, ...(nextToken ? { nextToken } : {}) })
  })
}
