import { beforeEach, describe, expect, it, vi } from 'vitest'

// _downloadFile streams via node-fetch's default export — mock the module so no
// real request is made.
vi.mock('node-fetch', () => ({ default: vi.fn() }))

import fetch from 'node-fetch'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'

const mockedFetch = vi.mocked(fetch)

// Minimal node-fetch Response stand-in. `headers.get` is case-insensitive to
// mirror the real Headers implementation (the download code relies on that).
const makeResponse = (headers: Record<string, string>, status = 200) => {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    body: {} as NodeJS.ReadableStream,
  }
}

const downloadArgs = {
  urlPath: '/2/files/download',
  filePath: '/root/report.csv',
  rootNamespaceId: 'ns-1',
  refreshToken: 'refresh-token',
}

const makeClient = () => {
  const client = new DropboxClient('refresh-token')
  // Both hit the network otherwise; the download path only needs them to resolve.
  vi.spyOn(client.dbxAuthClient, 'refreshAccessToken').mockResolvedValue(undefined as never)
  vi.spyOn(client.dbxAuthClient.authInstance, 'getAccessToken').mockReturnValue('access-token')
  return client
}

describe('DropboxClient#_downloadFile contentLength', () => {
  beforeEach(() => {
    mockedFetch.mockReset()
  })

  it('derives contentLength from the Dropbox-API-Result size', async () => {
    mockedFetch.mockResolvedValue(
      makeResponse({ 'Dropbox-API-Result': JSON.stringify({ size: 5000 }) }) as never,
    )

    const client = makeClient()
    const { body, contentLength } = await client._downloadFile(downloadArgs)

    expect(contentLength).toBe('5000')
    expect(body).toBeDefined()
  })

  it('ignores Content-Length even when present (it is the compressed size)', async () => {
    mockedFetch.mockResolvedValue(
      makeResponse({
        'content-length': '120', // gzip-compressed size — must NOT be used
        'Dropbox-API-Result': JSON.stringify({ size: 5000 }),
      }) as never,
    )

    const client = makeClient()
    const { contentLength } = await client._downloadFile(downloadArgs)

    expect(contentLength).toBe('5000')
  })

  it('accepts a zero size for empty files', async () => {
    mockedFetch.mockResolvedValue(
      makeResponse({ 'Dropbox-API-Result': JSON.stringify({ size: 0 }) }) as never,
    )

    const client = makeClient()
    const { contentLength } = await client._downloadFile(downloadArgs)

    expect(contentLength).toBe('0')
  })

  it('reads the header case-insensitively', async () => {
    mockedFetch.mockResolvedValue(
      makeResponse({ 'DROPBOX-API-RESULT': JSON.stringify({ size: 42 }) }) as never,
    )

    const client = makeClient()
    const { contentLength } = await client._downloadFile(downloadArgs)

    expect(contentLength).toBe('42')
  })

  it('throws when the Dropbox-API-Result header is missing', async () => {
    mockedFetch.mockResolvedValue(makeResponse({ 'content-length': '120' }) as never)

    const client = makeClient()
    await expect(client._downloadFile(downloadArgs)).rejects.toThrow(/Missing Dropbox-API-Result/)
  })

  it('throws when the header holds invalid JSON', async () => {
    mockedFetch.mockResolvedValue(makeResponse({ 'Dropbox-API-Result': 'not-json' }) as never)

    const client = makeClient()
    await expect(client._downloadFile(downloadArgs)).rejects.toThrow(
      /Could not parse Dropbox-API-Result/,
    )
  })

  it.each([
    ['missing', {}],
    ['not a number', { size: '5000' }],
    ['negative', { size: -1 }],
    ['non-integer', { size: 12.5 }],
  ])('throws when size is %s', async (_label, result) => {
    mockedFetch.mockResolvedValue(
      makeResponse({ 'Dropbox-API-Result': JSON.stringify(result) }) as never,
    )

    const client = makeClient()
    await expect(client._downloadFile(downloadArgs)).rejects.toThrow(
      /Invalid size in Dropbox-API-Result/,
    )
  })
})
