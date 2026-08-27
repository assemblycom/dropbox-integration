import crypto from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET, POST } from '@/app/api/webhook/dropbox/route'
import env from '@/config/server.env'
import { DropboxWebhook } from '@/features/webhook/dropbox/lib/webhook.service'
import { mockSleepInstant } from '../time'

// Keep the controller's 800ms wait instant.
vi.mock('@/utils/sleep')

// Capture after() callbacks instead of running them, so we can check work is deferred.
const afterCallbacks: Array<() => unknown> = []
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return { ...actual, after: (cb: () => unknown) => afterCallbacks.push(cb) }
})

afterEach(() => {
  vi.restoreAllMocks()
  afterCallbacks.length = 0
})

// Sign with the exact secret the controller verifies against — no drift from placeholder-env.
const sign = (body: string) =>
  crypto.createHmac('sha256', env.DROPBOX_APP_SECRET).update(body).digest('hex')
const postBody = JSON.stringify({ list_folder: { accounts: [] } })

const postReq = (headers: Record<string, string>, body: string = postBody) =>
  new NextRequest('https://example.test/api/webhook/dropbox', {
    method: 'POST',
    headers,
    body,
  })

describe('dropbox webhook route', () => {
  it('GET echoes the challenge as text/plain + nosniff', async () => {
    const req = new NextRequest('https://example.test/api/webhook/dropbox?challenge=abc123')
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('abc123')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('POST with a valid signature returns 200', async () => {
    mockSleepInstant()
    const res = await POST(postReq({ 'X-Dropbox-Signature': sign(postBody) }), undefined)
    expect(res.status).toBe(200)
  })

  it('POST returns 200 without blocking on processing, which is deferred to after()', async () => {
    mockSleepInstant()
    const handleSpy = vi
      .spyOn(DropboxWebhook.prototype, 'handleDropboxEvents')
      .mockResolvedValue(undefined)
    const body = JSON.stringify({ list_folder: { accounts: ['acc'] } })

    const res = await POST(postReq({ 'X-Dropbox-Signature': sign(body) }, body), undefined)

    expect(res.status).toBe(200)
    // Processing must not run before we reply.
    expect(handleSpy).not.toHaveBeenCalled()
    expect(afterCallbacks).toHaveLength(1)

    // Running the deferred work processes the accounts.
    await afterCallbacks[0]()
    expect(handleSpy).toHaveBeenCalledWith(['acc'])
  })

  it('a failed background run is swallowed, not thrown (Dropbox already got its 200)', async () => {
    mockSleepInstant()
    vi.spyOn(DropboxWebhook.prototype, 'handleDropboxEvents').mockRejectedValue(new Error('boom'))
    const body = JSON.stringify({ list_folder: { accounts: ['acc'] } })

    const res = await POST(postReq({ 'X-Dropbox-Signature': sign(body) }, body), undefined)

    expect(res.status).toBe(200)
    await expect(afterCallbacks[0]()).resolves.toBeUndefined()
  })

  it('POST with a tampered signature returns 403', async () => {
    mockSleepInstant()
    const res = await POST(postReq({ 'X-Dropbox-Signature': sign('a-different-body') }), undefined)
    expect(res.status).toBe(403)
  })

  it('POST without a signature returns 400', async () => {
    const res = await POST(postReq({}), undefined)
    expect(res.status).toBe(400)
  })
})
