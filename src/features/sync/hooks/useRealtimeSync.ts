import camelcaseKeys, { type CamelCaseKeys } from 'camelcase-keys'
import type { MapList } from '@/features/sync/types'
import type { ClientUser } from '@/lib/copilot/models/ClientUser.model'
import { useRealtime } from '@/lib/supabase/hooks/useRealtime'
import { useUserChannel } from './useUserChannel'

// Raw payload emitted by broadcast_channel_sync_status() (snake_case wire keys).
type ChannelSyncBroadcast = {
  id: string
  portal_id: string
  assembly_channel_id: string
  dbx_root_path: string
  status: boolean | null
  total_files_count: number
  synced_files_count: number
  last_synced_at: Date | null
}

export const useRealtimeSync = (user: ClientUser) => {
  const { setUserChannel } = useUserChannel()

  // this function calculates the percentage of synced files for a particular channel
  const calculateSyncedPercentage = (
    tempMapList: MapList[],
    newPayload: CamelCaseKeys<ChannelSyncBroadcast>,
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

  return useRealtime<ChannelSyncBroadcast>(
    `channel_sync:${user.portalId}`,
    'sync_update',
    (payload) => {
      const newPayload = camelcaseKeys(payload)

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
