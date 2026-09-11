import { eq } from 'drizzle-orm'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import db from '@/db'
import { fileFolderSync } from '@/db/schema/fileFolderSync.schema'
import User from '@/lib/copilot/models/User.model'
import type { Token } from '@/lib/copilot/types'
import { initiateAssemblyToDropboxSync } from '@/trigger/processFileSync'
import { copilotDownloadableFactory, copilotListPage } from '../factories'
import {
  mockAssemblyFileDownload,
  mockCopilot,
  mockDropboxGetMetadata,
  mockDropboxUploadSession,
} from '../msw'
import { channelSeeder, dropboxConnectionSeeder } from '../seeders'

// A file whose size Assembly doesn't report routes through the upload session (the
// same path a >150 MiB file takes). The single-shot upload is left unmocked, so if
// routing picked it the request would trip msw's onUnhandledRequest: 'error'. Keeping
// the body small lets one chunk exercise the real start -> finish wiring end-to-end;
// the >150 MiB decision and the byte-count guard are covered by unit tests.
describe('initial sync: Assembly -> Dropbox via upload session', () => {
  it('uploads a file with no reported size through an upload session', async () => {
    const accountId = 'acc-big'
    const rootNamespaceId = 'ns-big'
    const refreshToken = 'rt-big'
    const connection = await dropboxConnectionSeeder.create({
      accountId,
      rootNamespaceId,
      refreshToken,
    })
    const channel = await channelSeeder.create({
      portalId: connection.portalId,
      dbxRootPath: '/root',
    })
    const channelId = channel.assemblyChannelId

    const bigFile = copilotDownloadableFactory.build({
      path: 'big.txt',
      channelId,
      size: undefined, // unknown size -> session path
    })

    mockCopilot('/v1/files', () => HttpResponse.json(copilotListPage([bigFile])))
    mockDropboxGetMetadata({}) // path not found yet -> upload
    const session = mockDropboxUploadSession()
    mockAssemblyFileDownload() // small body, fetched from file.downloadUrl

    const user = new User('test-token', { workspaceId: connection.portalId } as Token)
    await initiateAssemblyToDropboxSync.triggerAndWait({
      dbxRootPath: '/root',
      assemblyChannelId: channelId,
      connectionToken: { refreshToken, accountId, rootNamespaceId },
      user,
    })

    // The session was driven (start + finish), not the single-shot upload.
    expect(session.calls.start).toBe(1)
    expect(session.calls.finish).toBe(1)

    const [row] = await db
      .select()
      .from(fileFolderSync)
      .where(eq(fileFolderSync.channelSyncId, channel.id))
    expect(row).toMatchObject({
      object: 'file',
      itemPath: '/big.txt',
      assemblyFileId: bigFile.id,
      dbxFileId: 'id:dbx:/root/big.txt', // committed by finish at the target path
      contentHash: 'hash-file',
      pendingAction: null,
      deletedAt: null,
    })
  })
})
