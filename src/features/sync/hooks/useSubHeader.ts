import { useUserChannel } from '@/features/sync/hooks/useUserChannel'
import { getFreshFolders } from '@/helper/table.helper'
import { generateRandomString } from '@/utils/random'

export const useSubHeader = () => {
  const { setUserChannel, tempMapList, folders } = useUserChannel()

  const handleAddRule = () => {
    const lastMap = tempMapList?.[tempMapList.length - 1]

    if (
      !lastMap ||
      (lastMap.dbxRootPath &&
        !!lastMap.fileChannelValue.length &&
        (lastMap.status !== false || lastMap.id)) // status can be null (pending), false or true
    ) {
      setUserChannel((prev) => ({
        ...prev,
        tempMapList: [
          ...prev.tempMapList,
          {
            dbxRootPath: '',
            fileChannelValue: [],
            status: false,
            fileChannelId: '',
            lastSyncedAt: null,
            resyncingAt: null,
            syncedPercentage: 0,
            tempId: `${generateRandomString(8)}`,
          },
        ],
        tempFolders: getFreshFolders(tempMapList, folders),
      }))
    }
  }

  return { handleAddRule }
}
