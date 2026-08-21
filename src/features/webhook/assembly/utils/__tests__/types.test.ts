import { describe, expect, it } from 'vitest'
import { AssemblyWebhookSchema } from '@/features/webhook/assembly/utils/types'

const validData = {
  id: '00000000-0000-4000-8000-000000000000',
  channelId: 'ch-1',
  name: 'f.txt',
  object: 'file',
  path: '/f.txt',
}

describe('AssemblyWebhookSchema', () => {
  it('accepts a well-formed webhook payload', () => {
    expect(
      AssemblyWebhookSchema.safeParse({ eventType: 'file.created', data: validData }).success,
    ).toBe(true)
  })

  it('rejects a payload with no data', () => {
    expect(AssemblyWebhookSchema.safeParse({ eventType: 'file.created' }).success).toBe(false)
  })

  it('rejects data whose id is not a uuid', () => {
    expect(
      AssemblyWebhookSchema.safeParse({
        eventType: 'file.created',
        data: { ...validData, id: 'not-a-uuid' },
      }).success,
    ).toBe(false)
  })
})
