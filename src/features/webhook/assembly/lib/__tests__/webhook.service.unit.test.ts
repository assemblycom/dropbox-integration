import { describe, expect, it, vi } from 'vitest'
import type { AssemblyWebhookEvent } from '@/features/webhook/assembly/utils/types'
import type User from '@/lib/copilot/models/User.model'

// Stub the Trigger SDK (both specifiers) so the service imports without a run context.
const { sdk } = vi.hoisted(() => ({
  sdk: {
    task: (def: unknown) => def,
    schedules: { task: (def: unknown) => def },
    logger: { info: () => undefined, error: () => undefined },
    ApiError: class ApiError extends Error {},
  },
}))
vi.mock('@trigger.dev/sdk/v3', () => sdk)
vi.mock('@trigger.dev/sdk', () => sdk)

const { AssemblyWebhookService } = await import('@/features/webhook/assembly/lib/webhook.service')

const svc = new AssemblyWebhookService(
  { portalId: 'p', token: 't' } as unknown as User,
  {
    refreshToken: 'rt',
    accountId: 'acc',
    rootNamespaceId: 'ns',
  } as never,
)

const event = (eventType: string, object: string) =>
  ({ eventType, data: { object } }) as unknown as AssemblyWebhookEvent

describe('AssemblyWebhookService#validateHandleableEvent', () => {
  it('returns the event type for a handleable event on a file/folder', () => {
    expect(svc.validateHandleableEvent(event('file.created', 'file'))).toBe('file.created')
    expect(svc.validateHandleableEvent(event('folder.deleted', 'folder'))).toBe('folder.deleted')
  })

  it('returns null for an event type it does not handle', () => {
    expect(svc.validateHandleableEvent(event('link.created', 'file'))).toBeNull()
  })

  it('returns null for a non-syncable object type (e.g. link)', () => {
    expect(svc.validateHandleableEvent(event('file.created', 'link'))).toBeNull()
  })
})

describe('AssemblyWebhookService#parseWebhook', () => {
  const validBody = {
    eventType: 'file.created',
    data: {
      id: '00000000-0000-4000-8000-000000000000',
      channelId: 'ch-1',
      name: 'f.txt',
      object: 'file',
      path: '/f.txt',
    },
  }

  it('parses a valid webhook body', () => {
    expect(svc.parseWebhook(validBody).eventType).toBe('file.created')
  })

  it('throws on an invalid webhook body', () => {
    expect(() => svc.parseWebhook({ nope: true })).toThrow()
  })
})
