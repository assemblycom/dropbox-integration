import camelcaseKeys from 'camelcase-keys'
import type { ChannelSyncSelectType } from '@/db/schema/channelSync.schema'
import type { MapList } from '@/features/sync/types'
import type { ClientUser } from '@/lib/copilot/models/ClientUser.model'
import { useRealtime } from '@/lib/supabase/hooks/useRealtime'
import { useUserChannel } from './useUserChannel'

// Curated broadcast payload built by broadcast_channel_sync_status() (camelCased).
type ChannelSyncStatusBroadcast = Pick<
  ChannelSyncSelectType,
  | 'id'
  | 'portalId'
  | 'assemblyChannelId'
  | 'dbxRootPath'
  | 'status'
  | 'totalFilesCount'
  | 'syncedFilesCount'
  | 'lastSyncedAt'
>

export const useRealtimeSync = (user: ClientUser) => {
  const { setUserChannel } = useUserChannel()

  // this function calculates the percentage of synced files for a particular channel
  const calculateSyncedPercentage = (
    tempMapList: MapList[],
    newPayload: ChannelSyncStatusBroadcast,
  ): { [key: string]: number } => {
    const index = tempMapList.findIndex(
      (mapItem) =>
        mapItem.dbxRootPath === newPayload.dbxRootPath &&
        mapItem.fileChannelId === newPayload.assemblyChannelId,
    )

    const numerator = newPayload.syncedFilesCount
    const denominator = newPayload.totalFilesCount

    if (denominator === 0) return { [index]: 0 }

    const totalPercentage = Math.ceil((numerator / denominator) * 100)
    return { [index]: totalPercentage > 100 ? 100 : totalPercentage }
  }

  return useRealtime<Record<string, unknown>>(
    `channel_sync:${user.portalId}`,
    'sync_update',
    (payload) => {
      const newPayload = camelcaseKeys(payload) as ChannelSyncStatusBroadcast

      setUserChannel((prev) => ({
        ...prev,
        tempMapList: prev.tempMapList.map((mapItem) => {
          if (
            mapItem.dbxRootPath === newPayload.dbxRootPath &&
            mapItem.fileChannelId === newPayload.assemblyChannelId
          ) {
            return {
              ...mapItem,
              status: newPayload.status,
              ...(newPayload.status ? { id: newPayload.id } : {}),
              lastSyncedAt: newPayload.lastSyncedAt,
            }
          }
          return mapItem
        }),
        syncedPercentage: {
          ...prev.syncedPercentage,
          ...calculateSyncedPercentage(prev.tempMapList, newPayload),
        },
      }))
    },
  )
}
