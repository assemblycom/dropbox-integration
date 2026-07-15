import { copilotApi } from 'copilot-node-sdk'
import { DropboxResponseError } from 'dropbox'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { CopilotAPI, isCopilotApiError } from '@/lib/copilot/CopilotAPI'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'
import {
  copilotFolderExists,
  copilotNotFound,
  dropboxGetMetadataNotFound,
  dropboxPathLookupNotFound,
  mockCopilot,
  mockDropboxContent,
  mockDropboxRpc,
  paginateCopilotListFiles,
  paginateDropboxListFolder,
} from '../msw'
import { server } from '../msw/server'

describe('MSW harness — interception', () => {
  it('rejects an unhandled request (proves error mode)', async () => {
    await expect(fetch('https://unregistered.example.com/x')).rejects.toThrow()
  })
})

describe('MSW harness — base handlers + hosts', () => {
  it('serves an empty Dropbox folder listing to the real SDK (node-fetch)', async () => {
    const dbx = new DropboxClient('refresh-token', null)
    const entries = await dbx.getAllFilesFolders('/root', false, true)
    expect(entries).toEqual([])
  })

  it('serves an empty Copilot file page to the real SDK (undici fetch)', async () => {
    const page = await new CopilotAPI('token')._listFiles('ch_1')
    expect(page.data).toEqual([])
  })

  it('routes content-host requests through an override (node-fetch manualFetch)', async () => {
    mockDropboxContent('/files/download', () =>
      HttpResponse.json(
        {},
        { status: 200, headers: { 'Dropbox-API-Result': JSON.stringify({ size: 5 }) } },
      ),
    )
    const dbx = new DropboxClient('refresh-token', 'ns_1')
    const { contentLength } = await dbx._downloadFile({
      urlPath: '/files/download',
      filePath: '/a.txt',
      rootNamespaceId: 'ns_1',
      refreshToken: 'refresh-token',
    })
    expect(contentLength).toBe('5')
  })
})

describe('MSW harness — Copilot error shapes', () => {
  it('reproduces isCopilotApiError 400 "Folder already exists"', async () => {
    mockCopilot('/v1/files', () => copilotFolderExists())
    const client = copilotApi({ apiKey: 'k', token: 't' })
    try {
      await client.listFiles({ channelId: 'ch' })
      expect.unreachable('listFiles should have thrown')
    } catch (err) {
      expect(isCopilotApiError(err)).toBe(true)
      if (isCopilotApiError(err)) {
        expect(err.status).toBe(400)
        expect(err.body.message).toBe('Folder already exists')
      }
    }
  })

  it('reproduces isCopilotApiError 404', async () => {
    mockCopilot('/v1/files', () => copilotNotFound())
    const client = copilotApi({ apiKey: 'k', token: 't' })
    try {
      await client.listFiles({ channelId: 'ch' })
      expect.unreachable('listFiles should have thrown')
    } catch (err) {
      expect(isCopilotApiError(err)).toBe(true)
      if (isCopilotApiError(err)) expect(err.status).toBe(404)
    }
  })
})

describe('MSW harness — Dropbox error shapes', () => {
  it('reproduces DropboxResponseError 409 with error.path not_found', async () => {
    mockDropboxRpc('/2/files/get_metadata', () => dropboxGetMetadataNotFound())
    const dbx = new DropboxClient('refresh-token', null).getDropboxClient()
    try {
      await dbx.filesGetMetadata({ path: '/missing.txt' })
      expect.unreachable('filesGetMetadata should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DropboxResponseError)
      const e = err as DropboxResponseError<{ error?: { path?: { '.tag'?: string } } }>
      expect(e.status).toBe(409)
      expect(e.error.error?.path?.['.tag']).toBe('not_found')
    }
  })

  it('reproduces DropboxResponseError 409 with path_lookup/not_found summary', async () => {
    mockDropboxRpc('/2/files/get_metadata', () => dropboxPathLookupNotFound())
    const dbx = new DropboxClient('refresh-token', null).getDropboxClient()
    try {
      await dbx.filesGetMetadata({ path: '/missing.txt' })
      expect.unreachable('filesGetMetadata should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(DropboxResponseError)
      const e = err as DropboxResponseError<{ error_summary?: string }>
      expect(e.status).toBe(409)
      expect(e.error.error_summary?.startsWith('path_lookup/not_found')).toBe(true)
    }
  })
})

describe('MSW harness — pagination', () => {
  it('traverses all Dropbox list_folder pages', async () => {
    const entries = Array.from({ length: 250 }, (_, i) => ({
      '.tag': 'file',
      id: `id:${i}`,
      name: `f${i}.txt`,
      path_lower: `/f${i}.txt`,
      path_display: `/f${i}.txt`,
    }))
    server.use(...paginateDropboxListFolder(entries, { pageSize: 100 }))
    const dbx = new DropboxClient('refresh-token', null)
    const result = await dbx.getAllFilesFolders('/root', false, true)
    expect(result).toHaveLength(250)
  })

  it('traverses all Copilot listFiles pages via nextToken', async () => {
    const items = Array.from({ length: 250 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      channelId: 'ch_1',
      name: `f${i}`,
      object: 'file',
      path: `/f${i}`,
    }))
    server.use(paginateCopilotListFiles(items, { pageSize: 100 }))
    const api = new CopilotAPI('token')
    const all: unknown[] = []
    let nextToken: string | undefined
    do {
      const pageResult = await api._listFiles('ch_1', nextToken)
      all.push(...pageResult.data)
      nextToken = pageResult.nextToken
    } while (nextToken)
    expect(all).toHaveLength(250)
  })

  it('rejects a non-positive pageSize instead of producing a non-progressing paginator', () => {
    expect(() => paginateDropboxListFolder([1], { pageSize: 0 })).toThrow(/positive integer/)
    expect(() => paginateCopilotListFiles([1], { pageSize: 0 })).toThrow(/positive integer/)
  })
})
