import httpStatus from 'http-status'
import { type NextRequest, NextResponse } from 'next/server'
import APIError from '@/errors/APIError'
import DropboxConnectionsService from '@/features/auth/lib/DropboxConnections.service'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import { SyncService } from '@/features/sync/lib/Sync.service'
import {
  FileSyncCreateRequestSchema,
  RemoveChannelSyncSchema,
  ResyncChannelRequestSchema,
  TotalFilesCountRequestSchema,
  UpdateConnectionStatusSchema,
} from '@/features/sync/types'
import { ResyncService } from '@/features/workers/resync-failed-files/lib/resync-failed-files.service'
import User from '@/lib/copilot/models/User.model'

export const initiateSync = async (req: NextRequest) => {
  const token = req.nextUrl.searchParams.get('token')
  const user = await User.authenticate(token)
  const dbxService = new DropboxConnectionsService(user)
  const connection = await dbxService.getConnectionForWorkspace()

  if (!connection.refreshToken) throw new Error('No refresh token found')
  if (!connection.accountId) throw new Error('No accountId found')

  const body = await req.json()
  const { fileChannelId, dbxRootPath } = FileSyncCreateRequestSchema.parse(body)

  // 2. get the channelId from the user
  const syncService = new SyncService(user, {
    refreshToken: connection.refreshToken,
    accountId: connection.accountId,
    rootNamespaceId: connection.rootNamespaceId,
  })

  // 3. get total files count (sum of all files in file channel + files in dropbox path)
  await syncService.storeTotalFilesCount(fileChannelId, dbxRootPath)

  // 4. start sync
  await syncService.initiateSync(fileChannelId, dbxRootPath)

  return NextResponse.json({ message: 'Sync initiated successfully' })
}

export const updateSyncStatus = async (req: NextRequest) => {
  const token = req.nextUrl.searchParams.get('token')
  const user = await User.authenticate(token)

  const body = await req.json()
  const { status, assemblyChannelId, dbxRootPath } = UpdateConnectionStatusSchema.parse(body)

  const dbxService = new DropboxConnectionsService(user)
  const connection = await dbxService.getConnectionForWorkspace()

  if (!connection.refreshToken) throw new APIError('No refresh token found', httpStatus.BAD_REQUEST)
  if (!connection.accountId) throw new APIError('No accountId found', httpStatus.BAD_REQUEST)

  const mapService = new MapFilesService(user, {
    refreshToken: connection.refreshToken,
    accountId: connection.accountId,
    rootNamespaceId: connection.rootNamespaceId,
  })
  await mapService.updateChannelMap(
    {
      status,
    },
    assemblyChannelId,
    dbxRootPath,
  )

  return NextResponse.json({ message: 'Sync status updated successfully' })
}

export const removeChannelSyncMapping = async (req: NextRequest) => {
  const token = req.nextUrl.searchParams.get('token')
  const user = await User.authenticate(token)

  const body = await req.json()
  const { channelSyncId } = RemoveChannelSyncSchema.parse(body)

  const dbxService = new DropboxConnectionsService(user)
  const connection = await dbxService.getConnectionForWorkspace()

  if (!connection.refreshToken) throw new APIError('No refresh token found', httpStatus.BAD_REQUEST)
  if (!connection.accountId) throw new APIError('No accountId found', httpStatus.BAD_REQUEST)

  const syncService = new SyncService(user, {
    refreshToken: connection.refreshToken,
    accountId: connection.accountId,
    rootNamespaceId: connection.rootNamespaceId,
  })
  await syncService.removeChannelSyncMapping(channelSyncId)

  return NextResponse.json({ message: 'Sync removed successfully' })
}

export const getTotalFilesCount = async (req: NextRequest) => {
  const token = req.nextUrl.searchParams.get('token')

  const requestParams = {
    assemblyChannelId: req.nextUrl.searchParams.get('assemblyChannelId'),
    dbxRootPath: req.nextUrl.searchParams.get('dbxRootPath'),
    limit: req.nextUrl.searchParams.get('limit') || undefined,
  }
  const { assemblyChannelId, dbxRootPath, limit } =
    TotalFilesCountRequestSchema.parse(requestParams)

  const user = await User.authenticate(token)
  const dbxService = new DropboxConnectionsService(user)
  const connection = await dbxService.getConnectionForWorkspace()

  if (!connection.refreshToken) throw new APIError('No refresh token found', httpStatus.NOT_FOUND)
  if (!connection.accountId) throw new APIError('No account Id found', httpStatus.NOT_FOUND)

  const syncService = new SyncService(user, {
    refreshToken: connection.refreshToken,
    accountId: connection.accountId,
    rootNamespaceId: connection.rootNamespaceId,
  })
  const count = await syncService.calculateTotalFilesCount(
    assemblyChannelId,
    dbxRootPath,
    limit ? parseInt(limit, 10) : undefined,
  )

  return NextResponse.json({ message: 'Total files count fetched successfully', count })
}

export const resyncChannelMapping = async (req: NextRequest) => {
  const token = req.nextUrl.searchParams.get('token')
  const user = await User.authenticate(token)

  const body = await req.json()
  const { channelSyncId } = ResyncChannelRequestSchema.parse(body)

  const resyncService = new ResyncService()
  const { pendingCount } = await resyncService.resyncFailedFilesForChannel(channelSyncId, user)

  return NextResponse.json({ message: 'Resync initiated', pendingCount })
}
