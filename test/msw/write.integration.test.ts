import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { ObjectType } from '@/db/constants'
import { DBX_URL_PATH } from '@/features/sync/constant'
import { CopilotAPI } from '@/lib/copilot/CopilotAPI'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'
import {
  dropboxFileMetadata,
  mockCopilotCreateFile,
  mockCopilotDeleteFile,
  mockDropboxCreateFolder,
  mockDropboxDownload,
  mockDropboxGetMetadata,
  mockDropboxLatestCursor,
  mockDropboxMove,
  mockDropboxUpload,
} from './write'

const dbxRaw = () => new DropboxClient('refresh-token', 'ns-1').getDropboxClient()

describe('Dropbox write RPC handlers', () => {
  it('get_metadata resolves a known path and 409s an unknown one', async () => {
    mockDropboxGetMetadata({ '/root/a.txt': dropboxFileMetadata({ path_display: '/root/a.txt' }) })
    const found = await dbxRaw().filesGetMetadata({ path: '/root/a.txt' })
    expect(found.result['.tag']).toBe('file')

    await expect(dbxRaw().filesGetMetadata({ path: '/root/missing.txt' })).rejects.toMatchObject({
      status: 409,
    })
  })

  it('create_folder_v2 returns folder metadata for the requested path', async () => {
    mockDropboxCreateFolder()
    const res = await dbxRaw().filesCreateFolderV2({ path: '/root/folder', autorename: false })
    expect(res.result.metadata.path_display).toBe('/root/folder')
  })

  it('move_v2 returns metadata at the destination path', async () => {
    mockDropboxMove()
    const res = await dbxRaw().filesMoveV2({
      from_path: '/root/a.txt',
      to_path: '/root/a (1).txt',
      autorename: false,
    })
    expect(res.result.metadata.path_display).toBe('/root/a (1).txt')
  })
})

describe('Dropbox content handlers', () => {
  const client = () => new DropboxClient('refresh-token', 'ns-1')

  it('upload returns metadata the client parses', async () => {
    mockDropboxUpload()
    const meta = await client().uploadFile({
      urlPath: DBX_URL_PATH.fileUpload,
      filePath: '/root/a.txt',
      body: Readable.from(['hello']) as unknown as NodeJS.ReadableStream,
      rootNamespaceId: 'ns-1',
      refreshToken: 'refresh-token',
    })
    expect(meta.pathDisplay).toBe('/root/a.txt') // camelKeys applied by the client
  })

  it('download returns a body and the size from the Dropbox-API-Result header', async () => {
    mockDropboxDownload({ '/root/a.txt': 'hello' })
    const { contentLength } = await client().downloadFile({
      urlPath: DBX_URL_PATH.fileDownload,
      filePath: '/root/a.txt',
      rootNamespaceId: 'ns-1',
      refreshToken: 'refresh-token',
    })
    expect(contentLength).toBe('5')
  })
})

describe('Copilot create-file handler', () => {
  it('createFile(folder) returns folder metadata (no upload URL needed)', async () => {
    mockCopilotCreateFile()
    const res = await new CopilotAPI('token').createFile('/folder', 'ch-1', ObjectType.FOLDER)
    expect(res.object).toBe(ObjectType.FOLDER)
  })

  it('createFile(file) returns an uploadUrl that accepts a PUT', async () => {
    mockCopilotCreateFile()
    const api = new CopilotAPI('token')
    const created = await api.createFile('/a.txt', 'ch-1', ObjectType.FILE)
    expect(created.uploadUrl).toBeTruthy()
    const put = await api.uploadFile(created.uploadUrl as string, '5', null)
    expect(put.status).toBe(200)
  })
})

describe('delta handlers (webhook flow)', () => {
  it('get_latest_cursor returns the given cursor', async () => {
    mockDropboxLatestCursor('cursor:xyz')
    const res = await dbxRaw().filesListFolderGetLatestCursor({ path: '/root', recursive: true })
    expect(res.result.cursor).toBe('cursor:xyz')
  })

  it('deleteFile resolves against the Copilot DELETE handler', async () => {
    mockCopilotDeleteFile()
    await expect(new CopilotAPI('token').deleteFile('file-id')).resolves.toBeDefined()
  })
})
