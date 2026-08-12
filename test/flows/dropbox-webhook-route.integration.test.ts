import crypto from 'node:crypto'
import { NextRequest } from 'next/server'
import { describe, expect, it, vi } from 'vitest'
import { GET, POST } from '@/app/api/webhook/dropbox/route'
import { mockSleepInstant } from '../time'

// The controller sleeps 800ms (ping-pong guard) before HMAC; keep it instant.
vi.mock('@/utils/sleep')

const SECRET = 'test-dropbox-app-secret' // placeholder DROPBOX_APP_SECRET (test/support/placeholder-env.ts)
const sign = (body: string) => crypto.createHmac('sha256', SECRET).update(body).digest('hex')
const postBody = JSON.stringify({ list_folder: { accounts: [] } })

const postReq = (headers: Record<string, string>) =>
  new NextRequest('https://example.test/api/webhook/dropbox', {
    method: 'POST',
    headers,
    body: postBody,
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
