import * as crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { generateToken } from '@/lib/copilot/generateToken'
import type { Token } from '@/lib/copilot/types'

// Decrypt with the same key + scheme as production.
const decrypt = (apiKey: string, tokenHex: string) => {
  const key = Buffer.from(crypto.createHmac('sha256', apiKey).digest('hex').slice(0, 32), 'hex')
  const buf = Buffer.from(tokenHex, 'hex')
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, buf.subarray(0, 16))
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf-8')
}

describe('generateToken', () => {
  const apiKey = 'test-api-key'
  const payload = { workspaceId: 'ws-1', internalUserId: 'user-1' } as Token

  it('produces a hex token that decrypts back to the original payload', () => {
    const token = generateToken(apiKey, payload)

    expect(token).toMatch(/^[0-9a-f]+$/)
    expect(JSON.parse(decrypt(apiKey, token))).toEqual(payload)
  })

  it('uses a random IV, so two encryptions of the same payload differ', () => {
    expect(generateToken(apiKey, payload)).not.toBe(generateToken(apiKey, payload))
  })
})
