import camelcaseKeys from 'camelcase-keys'
import type { ChannelSyncSelectType } from '@/db/schema/channelSync.schema'
import type { MapList } from '@/features/sync/types'
import type { ClientUser } from '@/lib/copilot/models/ClientUser.model'
import { useRealtime } from '@/lib/supabase/hooks/useRealtime'
import { useUserChannel } from './useUserChannel'

export const useRealtimeSync = (user: ClientUser) => {
  const { setUserChannel } = useUserChannel()

  // this function calculates the percentage of synced files for a particular channel
  const calculateSyncedPercentage = (
    tempMapList: MapList[],
    newPayload: ChannelSyncSelectType,
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

  return useRealtime<ChannelSyncSelectType>(
    user.portalId,
    'channel_sync',
    `portal_id=eq.${user.portalId}`,
    'UPDATE',
    (payload) => {
      const newPayload = camelcaseKeys(payload.new) as ChannelSyncSelectType

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
              resyncingAt: newPayload.resyncingAt,
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
