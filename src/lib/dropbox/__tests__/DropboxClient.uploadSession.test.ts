import { beforeEach, describe, expect, it, vi } from 'vitest'

// The session upload streams via node-fetch — mock the module so no real request is made.
vi.mock('node-fetch', () => ({ default: vi.fn() }))

import fetch from 'node-fetch'
import { DropboxClient } from '@/lib/dropbox/DropboxClient'

const mockedFetch = vi.mocked(fetch)

type Call = { url: string; arg: Record<string, unknown>; bodyLength: number }

// Reads the captured fetch calls back into a comparable shape.
const readCalls = (): Call[] =>
  mockedFetch.mock.calls.map(([url, init]) => {
    const headers = (init as { headers: Record<string, string> }).headers
    const body = (init as { body?: Buffer }).body
    return {
      url: url as string,
      arg: JSON.parse(headers['Dropbox-API-Arg']),
      bodyLength: body ? body.length : 0,
    }
  })

const jsonResponse = (data: unknown, status = 200) => ({
  status,
  json: async () => data,
  text: async () => JSON.stringify(data),
})

const finishMetadata = {
  name: 'big.bin',
  path_display: '/root/big.bin',
  id: 'id:big',
  size: 5,
  content_hash: 'hash-big',
}

// biome-ignore lint/suspicious/useAwait: an async generator stands in for the streamed body
async function* source(bytes: number[]): AsyncGenerator<Uint8Array> {
  yield Uint8Array.from(bytes)
}

const makeClient = () => {
  const client = new DropboxClient('refresh-token')
  vi.spyOn(client.dbxAuthClient, 'refreshAccessToken').mockResolvedValue(undefined as never)
  vi.spyOn(client.dbxAuthClient.authInstance, 'getAccessToken').mockReturnValue('access-token')
  return client
}

const uploadArgs = () => ({
  filePath: '/root/big.bin',
  getBody: () => Promise.resolve(source([1, 2, 3, 4, 5])),
  rootNamespaceId: 'ns-1',
  refreshToken: 'refresh-token',
  chunkSize: 2,
  expectedSize: 5,
})

describe('DropboxClient#_uploadFileSession', () => {
  beforeEach(() => {
    mockedFetch.mockReset()
  })

  it('starts a session, appends each chunk at the right offset, then finishes', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ session_id: 'sess-1' }) as never) // start
      .mockResolvedValueOnce(jsonResponse({}) as never) // append 1
      .mockResolvedValueOnce(jsonResponse({}) as never) // append 2
      .mockResolvedValueOnce(jsonResponse(finishMetadata) as never) // finish

    const client = makeClient()
    const result = await client._uploadFileSession(uploadArgs())

    const calls = readCalls()
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringContaining('/files/upload_session/start'),
      expect.stringContaining('/files/upload_session/append_v2'),
      expect.stringContaining('/files/upload_session/append_v2'),
      expect.stringContaining('/files/upload_session/finish'),
    ])

    // 5 bytes at chunk size 2 → chunks of 2, 2, 1.
    expect(calls.map((c) => c.bodyLength)).toEqual([2, 2, 1, 0])

    // Append cursors advance by the bytes already sent.
    expect(calls[1].arg.cursor).toEqual({ session_id: 'sess-1', offset: 2 })
    expect(calls[2].arg.cursor).toEqual({ session_id: 'sess-1', offset: 4 })

    // Finish commits at the total offset and the target path.
    expect(calls[3].arg.cursor).toEqual({ session_id: 'sess-1', offset: 5 })
    expect(calls[3].arg.commit).toMatchObject({
      path: '/root/big.bin',
      mode: 'add',
      autorename: false,
    })

    expect(result).toEqual({
      name: 'big.bin',
      pathDisplay: '/root/big.bin',
      id: 'id:big',
      size: 5,
      contentHash: 'hash-big',
    })
  })

  it('throws without finishing when the streamed bytes do not match the expected size', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ session_id: 'sess-1' }) as never) // start
      .mockResolvedValueOnce(jsonResponse({}) as never) // append
      .mockResolvedValueOnce(jsonResponse({}) as never) // append

    const client = makeClient()
    // Body is 5 bytes but the caller expected 8 — a truncated/expired download.
    await expect(client._uploadFileSession({ ...uploadArgs(), expectedSize: 8 })).rejects.toThrow(
      /Streamed 5 bytes but expected 8/,
    )

    // finish must not run — no file is committed from a short body.
    expect(readCalls().some((c) => c.url.includes('/finish'))).toBe(false)
  })

  it('throws the Dropbox error when a session call fails', async () => {
    mockedFetch.mockResolvedValueOnce(
      jsonResponse({ error_summary: 'too_many_requests' }, 429) as never,
    )

    const client = makeClient()
    await expect(client._uploadFileSession(uploadArgs())).rejects.toThrow(/too_many_requests/)
  })

  // Each invocation must pull a fresh stream and open its own session, so retries are clean.
  it('pulls a fresh stream from getBody and opens a new session on every invocation', async () => {
    const getBody = () => Promise.resolve(source([1, 2, 3]))
    const getBodySpy = vi.fn(getBody)
    const oneCycle = [
      jsonResponse({ session_id: 'sess' }), // start
      jsonResponse({}), // append
      jsonResponse(finishMetadata), // finish
    ]
    mockedFetch
      .mockResolvedValueOnce(oneCycle[0] as never)
      .mockResolvedValueOnce(oneCycle[1] as never)
      .mockResolvedValueOnce(oneCycle[2] as never)
      .mockResolvedValueOnce(oneCycle[0] as never)
      .mockResolvedValueOnce(oneCycle[1] as never)
      .mockResolvedValueOnce(oneCycle[2] as never)

    const client = makeClient()
    const args = { ...uploadArgs(), getBody: getBodySpy, expectedSize: 3 }
    await client._uploadFileSession(args)
    await client._uploadFileSession(args)

    expect(getBodySpy).toHaveBeenCalledTimes(2)
    expect(readCalls().filter((c) => c.url.includes('/start'))).toHaveLength(2)
  })

  it('opens and finishes an empty session for a zero-byte file', async () => {
    mockedFetch
      .mockResolvedValueOnce(jsonResponse({ session_id: 'sess-empty' }) as never) // start
      .mockResolvedValueOnce(jsonResponse({ ...finishMetadata, size: 0 }) as never) // finish

    const client = makeClient()
    const result = await client._uploadFileSession({
      ...uploadArgs(),
      getBody: () => Promise.resolve(source([])),
      expectedSize: 0,
    })

    const calls = readCalls()
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringContaining('/files/upload_session/start'),
      expect.stringContaining('/files/upload_session/finish'),
    ])
    expect(calls[0].bodyLength).toBe(0)
    expect(result.size).toBe(0)
  })
})
