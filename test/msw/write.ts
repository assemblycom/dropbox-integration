import { randomUUID } from 'node:crypto'
import { HttpResponse, http } from 'msw'
import { DBX_URL_PATH } from '@/features/sync/constant'
import type { CopilotFileRetrieve } from '@/lib/copilot/types'
import { copilotNotFound, dropboxGetMetadataNotFound } from './errors'
import { COPILOT_HOST } from './hosts'
import { mockCopilot, mockDropboxContent, mockDropboxRpc } from './overrides'
import { server } from './server'

export interface DropboxMeta {
  // 'deleted' lets a fixture stand in for a DeletedMetadataReference (get_metadata's
  // unexpected-tag branch); file/folder-only fields stay optional for that case.
  '.tag': 'file' | 'folder' | 'deleted'
  id: string
  name: string
  path_display: string
  path_lower: string
  content_hash?: string
  size?: number
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

export function dropboxFileMetadata(overrides: Partial<DropboxMeta> = {}): DropboxMeta {
  const path_display = overrides.path_display ?? '/root/file.txt'
  return {
    '.tag': 'file',
    id: 'id:dbx-file',
    name: nameOf(path_display),
    path_display,
    path_lower: path_display.toLowerCase(),
    content_hash: 'hash-file',
    size: 5,
    ...overrides,
  }
}

export function dropboxFolderMetadata(overrides: Partial<DropboxMeta> = {}): DropboxMeta {
  const path_display = overrides.path_display ?? '/root/folder'
  return {
    '.tag': 'folder',
    id: 'id:dbx-folder',
    name: nameOf(path_display),
    path_display,
    path_lower: path_display.toLowerCase(),
    ...overrides,
  }
}

// get_metadata: the SDK returns the metadata as the response body (wrapped into `.result`).
export function mockDropboxGetMetadata(byPath: Record<string, DropboxMeta>): void {
  mockDropboxRpc('/2/files/get_metadata', async ({ request }) => {
    const { path } = (await request.json()) as { path: string }
    const meta = byPath[path]
    return meta ? HttpResponse.json(meta) : dropboxGetMetadataNotFound()
  })
}

export function mockDropboxCreateFolder(
  resolve: (path: string) => DropboxMeta = (path) => dropboxFolderMetadata({ path_display: path }),
): void {
  mockDropboxRpc('/2/files/create_folder_v2', async ({ request }) => {
    const { path } = (await request.json()) as { path: string }
    return HttpResponse.json({ metadata: resolve(path) })
  })
}

export function mockDropboxMove(
  resolve: (fromPath: string, toPath: string) => DropboxMeta = (_from, to) =>
    dropboxFileMetadata({ path_display: to }),
): void {
  mockDropboxRpc('/2/files/move_v2', async ({ request }) => {
    const { from_path, to_path } = (await request.json()) as { from_path: string; to_path: string }
    return HttpResponse.json({ metadata: resolve(from_path, to_path) })
  })
}

// Reads the file path the client stamps into the Dropbox-API-Arg header.
function filePathFromArg(request: Request): string {
  const arg = request.headers.get('Dropbox-API-Arg')
  return arg ? (JSON.parse(arg) as { path: string }).path : ''
}

// Upload: the client parses the JSON body via DropboxFileMetadataSchema + camelKeys.
// Default gives a distinct dbxFileId per path so multiple uploads in one test don't
// collide on the (portalId, channelSyncId, dbxFileId) partial unique index.
export function mockDropboxUpload(
  resolve: (filePath: string) => DropboxMeta = (path) =>
    dropboxFileMetadata({ path_display: path, id: `id:dbx:${path}` }),
): void {
  mockDropboxContent(DBX_URL_PATH.fileUpload, ({ request }) =>
    HttpResponse.json(resolve(filePathFromArg(request))),
  )
}

// Download: body + Dropbox-API-Result header carrying the size (client reads size, not Content-Length).
export function mockDropboxDownload(
  bodyByPath: Record<string, string>,
  opts: { size?: number } = {},
): void {
  mockDropboxContent(DBX_URL_PATH.fileDownload, ({ request }) => {
    const path = filePathFromArg(request)
    const body = bodyByPath[path] ?? ''
    return new HttpResponse(body, {
      status: 200,
      headers: { 'Dropbox-API-Result': JSON.stringify({ size: opts.size ?? body.length }) },
    })
  })
}

// Assembly file body source (uploadFileInDropbox fetches file.downloadUrl); matches copilotDownloadableFactory.
export function mockAssemblyFileDownload(body = 'file-bytes'): void {
  server.use(http.get('https://content.example/download', () => new HttpResponse(body)))
}

const DEFAULT_UPLOAD_PATH = '/v1/files/upload-url'

// createFile POST /v1/files/{fileType}; for files, hands back an uploadUrl and registers its PUT.
export function mockCopilotCreateFile(opts: { uploadUrl?: string } = {}): void {
  const uploadUrl = opts.uploadUrl ?? `${COPILOT_HOST}${DEFAULT_UPLOAD_PATH}`

  mockCopilot(
    '/v1/files/:fileType',
    async ({ request, params }) => {
      // The SDK sends `channelID` (capital ID); the response echoes `channelId`.
      const { path, channelID } = (await request.json()) as { path: string; channelID: string }
      const fileType = params.fileType as string
      return HttpResponse.json({
        // Real Copilot returns a UUID; callers persist it into a uuid() column.
        id: randomUUID(),
        channelId: channelID,
        name: nameOf(path),
        object: fileType,
        path,
        ...(fileType === 'file' ? { uploadUrl } : {}),
      })
    },
    'post',
  )
  server.use(http.put(uploadUrl, () => new HttpResponse(null, { status: 200 })))
}

// get_latest_cursor — used on first-time delta and the root-move 409 branch.
export function mockDropboxLatestCursor(cursor = 'cursor:latest'): void {
  mockDropboxRpc('/2/files/list_folder/get_latest_cursor', () => HttpResponse.json({ cursor }))
}

// Dropbox delete_v2. Records the attempted delete paths (recorded even when `error` is set)
// so a test can check which path was targeted.
// Per the Dropbox API spec, delete_v2 returns the item's file/folder metadata (not a "deleted" tag).
// Pass `error` to make every call fail (e.g. dropboxPathLookupNotFound for the quiet-delete swallow path).
export function mockDropboxDeleteFile(opts: { error?: () => Response } = {}): {
  deletedPaths: string[]
} {
  const deletedPaths: string[] = []
  mockDropboxRpc('/2/files/delete_v2', async ({ request }) => {
    const { path } = (await request.json()) as { path: string }
    deletedPaths.push(path)
    if (opts.error) return opts.error()
    return HttpResponse.json({ metadata: dropboxFileMetadata({ path_display: path }) })
  })
  return { deletedPaths }
}

// Copilot retrieveFile (GET /v1/files/{id}). Returns the mapped file, or 404 for an unknown id.
export function mockCopilotRetrieveFile(byId: Record<string, CopilotFileRetrieve>): void {
  mockCopilot(
    '/v1/files/:id',
    ({ params }) => {
      const file = byId[params.id as string]
      return file ? HttpResponse.json(file) : copilotNotFound()
    },
    'get',
  )
}

// Copilot file delete (DELETE /v1/files/{id}) — used by the delete + content-change leaves.
// Returns { deletedIds } capturing the ids sent (recorded even when `error` is set), so tests
// can verify WHICH file was targeted and how many times (the DB row alone can't see the outbound id).
// Pass `error` to make every call fail (e.g. copilotNotFound for the quiet-delete swallow path).
export function mockCopilotDeleteFile(opts: { error?: () => Response } = {}): {
  deletedIds: string[]
} {
  const deletedIds: string[] = []
  mockCopilot(
    '/v1/files/:id',
    ({ params }) => {
      deletedIds.push(params.id as string)
      if (opts.error) return opts.error()
      return HttpResponse.json({})
    },
    'delete',
  )
  return { deletedIds }
}
