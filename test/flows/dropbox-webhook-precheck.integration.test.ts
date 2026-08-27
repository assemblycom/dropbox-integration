import { afterEach, describe, expect, it, vi } from 'vitest'
import { DropboxWebhook } from '@/features/webhook/dropbox/lib/webhook.service'
import { processDropboxChanges } from '@/trigger/processFileSync'
import { dropboxEntryFactory } from '../factories'
import { mockDropboxRpc, paginateDropboxListFolder, server } from '../msw'
import { channelSeeder, dropboxConnectionSeeder } from '../seeders'

const seedAccount = () =>
  dropboxConnectionSeeder.create({ accountId: 'acc', rootNamespaceId: 'ns', refreshToken: 'rt' })

afterEach(() => vi.restoreAllMocks())

describe('DropboxWebhook#accountHasPendingChanges', () => {
  it('returns false when no delta entry falls under a channel root', async () => {
    const connection = await seedAccount()
    await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
      dbxCursor: 'cursor:0',
    })
    // The whole delta is outside the synced root — nothing to sync.
    server.use(
      ...paginateDropboxListFolder([dropboxEntryFactory.build({ path_display: '/other/x.txt' })]),
    )

    expect(await new DropboxWebhook().accountHasPendingChanges('acc')).toBe(false)
  })

  it('returns true when a delta entry falls under a channel root', async () => {
    const connection = await seedAccount()
    await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
      dbxCursor: 'cursor:0',
    })
    server.use(
      ...paginateDropboxListFolder([dropboxEntryFactory.build({ path_display: '/root/x.txt' })]),
    )

    expect(await new DropboxWebhook().accountHasPendingChanges('acc')).toBe(true)
  })

  it('returns true when a channel has no cursor (cannot peek safely)', async () => {
    const connection = await seedAccount()
    await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
      dbxCursor: null,
    })

    expect(await new DropboxWebhook().accountHasPendingChanges('acc')).toBe(true)
  })

  it('returns false when the account has no active channels', async () => {
    await seedAccount()

    expect(await new DropboxWebhook().accountHasPendingChanges('acc')).toBe(false)
  })

  it('returns false when the connection has no refresh token (job cannot sync)', async () => {
    await dropboxConnectionSeeder.create({
      accountId: 'acc',
      rootNamespaceId: 'ns',
      refreshToken: null,
    })

    expect(await new DropboxWebhook().accountHasPendingChanges('acc')).toBe(false)
  })

  it('throws on a Dropbox error so the caller can fail open and trigger', async () => {
    const connection = await seedAccount()
    await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
      dbxCursor: 'cursor:0',
    })
    mockDropboxRpc('/2/files/list_folder/continue', () =>
      Response.json({ error_summary: 'reset/', error: { '.tag': 'reset' } }, { status: 409 }),
    )

    await expect(new DropboxWebhook().accountHasPendingChanges('acc')).rejects.toBeDefined()
  })

  it('returns true when an entry has no path_display (fail open)', async () => {
    const connection = await seedAccount()
    await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
      dbxCursor: 'cursor:0',
    })
    // Raw entry with no path_display (e.g. unmounted) — can't tell → treat as relevant.
    server.use(...paginateDropboxListFolder([{ '.tag': 'deleted', name: 'x' }]))

    expect(await new DropboxWebhook().accountHasPendingChanges('acc')).toBe(true)
  })

  it('does not match a sibling folder that shares the root prefix', async () => {
    const connection = await seedAccount()
    await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
      dbxCursor: 'cursor:0',
    })
    server.use(
      ...paginateDropboxListFolder([dropboxEntryFactory.build({ path_display: '/rootbar/x.txt' })]),
    )

    expect(await new DropboxWebhook().accountHasPendingChanges('acc')).toBe(false)
  })

  it('fails open: handleDropboxEvents triggers the job when the pre-check throws', async () => {
    await seedAccount() // lastWebhookSyncStartedAt null → not debounced → reaches the pre-check
    vi.spyOn(DropboxWebhook.prototype, 'accountHasPendingChanges').mockRejectedValue(
      new Error('boom'),
    )
    const triggerSpy = vi
      .spyOn(processDropboxChanges, 'trigger')
      .mockResolvedValue(undefined as never)

    await new DropboxWebhook().handleDropboxEvents(['acc'])

    expect(triggerSpy).toHaveBeenCalledWith('acc', { concurrencyKey: 'acc' })
  })
})
