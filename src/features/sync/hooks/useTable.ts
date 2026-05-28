import { useCallback, useEffect, useState } from 'react'
import { useAuthContext } from '@/features/auth/hooks/useAuth'
import { useDialogContext } from '@/features/sync/hooks/useDialogContext'
import { useUserChannel } from '@/features/sync/hooks/useUserChannel'
import type { MapList } from '@/features/sync/types'
import { customFetcher } from '@/helper/fetcher.helper'
import { getFreshFolders } from '@/helper/table.helper'
import { type UserCompanySelectorInputValue, UserCompanySelectorObject } from '@/lib/copilot/types'
import { sanitizePath } from '@/utils/filePath'

export const useTable = () => {
  const { user } = useAuthContext()
  const { tempMapList, setUserChannel, userChannelList, folders } = useUserChannel()
  const [fileChannelIds, setFileChannelIds] = useState<{
    [key: number]: string
  }>()
  const [filteredValue, setFilteredValue] = useState<{ [key: number]: string | null }>()

  // to calculate total files count
  const [localFileChannelId, setLocalFileChannelId] = useState<string | null>(null)
  const [localDbxRootPath, setLocalDbxRootPath] = useState<string | null>(null)
  const [tempTotalFilesCount, setTempTotalFilesCount] = useState<number>(0)
  const [totalCountLoading, setTotalCountLoading] = useState(false)
  const maxFileLimit = 500

  // for dialog
  const { setDialogAttributes, toggleDialog } = useDialogContext()

  const updateTempMapListState = (index: number, option: Partial<MapList>) => {
    setUserChannel((prev) => ({
      ...prev,
      tempMapList: prev.tempMapList.map((mapItem, i) => {
        if (i === index) {
          return {
            ...mapItem,
            ...option,
          }
        }
        return mapItem
      }),
    }))
  }

  const handleSync = async (index: number) => {
    const payload = {
      fileChannelId: fileChannelIds?.[index] || tempMapList[index].fileChannelId,
      dbxRootPath: filteredValue?.[index] || tempMapList[index].dbxRootPath,
    }
    updateTempMapListState(index, { status: null })
    toggleDialog(false)

    try {
      await customFetcher(
        'POST',
        `/api/sync?token=${user.token}`,
        {},
        {
          body: JSON.stringify(payload),
        },
      )
    } catch (error: unknown) {
      console.error(error)
      updateTempMapListState(index, { status: false })
    }
    setLocalDbxRootPath(null)
    setLocalFileChannelId(null)
  }

  const getFileChannelName = (index: number) => {
    const clientId = tempMapList[index].fileChannelValue[0].id
    const companyId = tempMapList[index].fileChannelValue[0].companyId
    const object = tempMapList[index].fileChannelValue[0].object

    if (object === UserCompanySelectorObject.CLIENT) {
      const name = userChannelList.clients?.find((item) => item.value === clientId)?.label
      const companyName = userChannelList.companies?.find(
        (item) => item.companyId === companyId,
      )?.label
      return `${name} ${companyName ? `(${companyName})` : ''}`
    }

    if (object === UserCompanySelectorObject.COMPANY) {
      return userChannelList.companies?.find((item) => item.value === companyId)?.label
    }
  }

  const openSyncConfirmDialog = async (index: number) => {
    if (tempTotalFilesCount >= maxFileLimit) {
      const fileChannelName = getFileChannelName(index)
      const description = `You're about to sync <strong>${maxFileLimit}+</strong> files between <strong>${fileChannelName}</strong> and <strong>${sanitizePath(tempMapList[index].dbxRootPath)}</strong>. This may take some time to complete and will run in the background.`
      setDialogAttributes((prev) => ({
        ...prev,
        isOpen: true,
        title: 'Confirm large sync',
        description,
        onConfirm: () => handleSync(index),
      }))
    } else {
      await handleSync(index)
    }
  }

  const getTotalFilesCount = useCallback(async () => {
    if (!localFileChannelId || !localDbxRootPath) return

    setTotalCountLoading(true)
    const urlPath = `/api/sync/total-files-count?token=${user.token}&assemblyChannelId=${encodeURIComponent(localFileChannelId)}&dbxRootPath=${encodeURIComponent(localDbxRootPath)}`

    const response = await customFetcher('GET', urlPath, {}, {})
    if (!response.ok) {
      throw new Error(`Something went wrong. Status code: ${response.status}`)
    }

    const resp = await response.json()
    const count = resp.count

    setTempTotalFilesCount(count)
    setTotalCountLoading(false)
  }, [localDbxRootPath, localFileChannelId, user.token])

  useEffect(() => {
    // biome-ignore lint/nursery/noFloatingPromises: floating promises are fine here
    if (localDbxRootPath && localFileChannelId) getTotalFilesCount()
  }, [getTotalFilesCount, localDbxRootPath, localFileChannelId])

  const onUserSelectorValueChange = (val: UserCompanySelectorInputValue[], index: number) => {
    let fileChannelId: string | undefined

    if (!val.length) return

    if (val[0].object === UserCompanySelectorObject.COMPANY) {
      fileChannelId = userChannelList.companies?.find(
        (company) => company.value === val[0].id,
      )?.fileChannelId
    } else if (val[0].object === UserCompanySelectorObject.CLIENT) {
      fileChannelId = userChannelList.clients?.find(
        (client) => client.value === val[0].id && client.companyId === val[0].companyId,
      )?.fileChannelId
    }

    if (!fileChannelId) return

    setFileChannelIds((prev) => ({ ...prev, [index]: fileChannelId }))
    updateTempMapListState(index, { fileChannelValue: val, fileChannelId })

    // upon select, set fileChannelId to get all files/folder
    setLocalFileChannelId(fileChannelId)
  }

  const onDropboxFolderChange = (val: string | null, index: number) => {
    setFilteredValue((prev) => ({ ...prev, [index]: val }))
    updateTempMapListState(index, { dbxRootPath: val || '' })

    // upon select, set dropbox folder path to get all files/folder
    setLocalDbxRootPath(val)
  }

  const handleItemRemove = (index: number) => {
    setUserChannel((prev) => ({
      ...prev,
      tempMapList: prev.tempMapList.filter((_, i) => i !== index),
      tempFolders: getFreshFolders(
        prev.tempMapList.filter((_, i) => i !== index),
        folders,
      ),
    }))
    setFilteredValue((prev) => ({ ...prev, [index]: null }))
    setLocalDbxRootPath(null)
    setLocalFileChannelId(null)
  }

  const handleSyncStatusChange = async (index: number) => {
    const payload = {
      status: !tempMapList[index].status,
      assemblyChannelId: tempMapList[index].fileChannelId,
      dbxRootPath: filteredValue?.[index] || tempMapList[index].dbxRootPath,
    }

    updateTempMapListState(index, { status: !tempMapList[index].status })

    try {
      await customFetcher(
        'POST',
        `/api/sync/update-status?token=${user.token}`,
        {},
        {
          body: JSON.stringify(payload),
        },
      )
    } catch (error: unknown) {
      console.error(error)
      updateTempMapListState(index, { status: !tempMapList[index].status })
    }
  }

  return {
    onUserSelectorValueChange,
    filteredValue,
    onDropboxFolderChange,
    handleItemRemove,
    handleSyncStatusChange,
    openSyncConfirmDialog,
    totalCountLoading,
  }
}

export const useUpdateUserList = () => {
  const { userChannelList, tempMapList } = useUserChannel()
  const selectedChannelIds = tempMapList.map((map) => map.fileChannelId)

  const getNewChannelList = useCallback(() => {
    const newClientList = userChannelList.clients?.filter(
      (client) => client.fileChannelId && !selectedChannelIds.includes(client.fileChannelId),
    )
    const newCompanyList = userChannelList.companies?.filter(
      (company) => company.fileChannelId && !selectedChannelIds.includes(company.fileChannelId),
    )
    const newChannelList = { clients: newClientList, companies: newCompanyList }

    return newChannelList
  }, [userChannelList, selectedChannelIds])

  return { unselectedChannelList: getNewChannelList() }
}

export const useResyncChannel = () => {
  const { user } = useAuthContext()
  const { setUserChannel } = useUserChannel()

  const setResyncingAt = (channelSyncId: string, value: Date | null) => {
    setUserChannel((prev) => ({
      ...prev,
      tempMapList: prev.tempMapList.map((m) =>
        m.id === channelSyncId ? { ...m, resyncingAt: value } : m,
      ),
    }))
  }

  const resyncChannel = async (channelSyncId?: string) => {
    if (!channelSyncId) return

    // Optimistic UI: realtime will overwrite this with the server timestamp.
    setResyncingAt(channelSyncId, new Date())

    try {
      await customFetcher(
        'POST',
        `/api/sync/resync?token=${user.token}`,
        {},
        {
          body: JSON.stringify({ channelSyncId }),
        },
      )
    } catch (error: unknown) {
      console.error(error)
      setResyncingAt(channelSyncId, null)
    }
  }

  return {
    resyncChannel,
  }
}

export const useRemoveChannelSync = () => {
  const { user } = useAuthContext()
  const { setUserChannel, tempMapList } = useUserChannel()

  const { setDialogAttributes, toggleDialog } = useDialogContext()

  const removeChannelSync = async (channelSyncId?: string) => {
    toggleDialog(false)

    const localMapList = tempMapList
    setUserChannel((prev) => ({
      ...prev,
      tempMapList: prev.tempMapList.filter((item) => item.id !== channelSyncId),
    }))

    try {
      await customFetcher(
        'DELETE',
        `/api/sync/remove?token=${user.token}`,
        {},
        {
          body: JSON.stringify({
            channelSyncId,
          }),
        },
      )
    } catch (error: unknown) {
      setUserChannel((prev) => ({
        ...prev,
        tempMapList: localMapList,
      }))
      console.error(error)
    }
  }

  const openConfirmDialog = (id?: string) => {
    setDialogAttributes((prev) => ({
      ...prev,
      isOpen: true,
      title: 'Remove channel sync',
      description: 'Are you sure you want to remove this channel sync?',
      onConfirm: () => removeChannelSync(id),
    }))
  }

  return {
    openConfirmDialog,
  }
}
