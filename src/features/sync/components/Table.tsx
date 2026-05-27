'use client'

import { Button } from 'copilot-design-system'
import { Loader } from '@/components/layouts/Loader'
import { CopilotSelector } from '@/components/ui/CopilotSelector'
import { Dialog } from '@/components/ui/dialog/Dialog'
import TreeSelect from '@/components/ui/dropbox/tree-select/TreeSelect'
import { cn } from '@/components/utils'
import LastSyncAt from '@/features/sync/components/LastSyncedAt'
import { getCompanySelectorValue } from '@/features/sync/helper/sync.helper'
import { useDialogContext } from '@/features/sync/hooks/useDialogContext'
import { useFolder } from '@/features/sync/hooks/useFolder'
import {
  useRemoveChannelSync,
  useResyncChannel,
  useTable,
  useUpdateUserList,
} from '@/features/sync/hooks/useTable'
import { useUserChannel } from '@/features/sync/hooks/useUserChannel'

const MappingTableStatus = ({
  status,
  percentage,
}: {
  status: boolean | null
  percentage: number
}) => {
  if (status === null) return <span className="text-gray-500 text-sm">{percentage}% completed</span>

  return (
    <>
      {status ? (
        <span className="text-green-700 text-sm">Active</span>
      ) : (
        <span className="text-gray-500 text-sm">Inactive</span>
      )}
    </>
  )
}

const MappingTableNoRecords = () => {
  return (
    <tr>
      <td colSpan={5} className="py-12">
        <div className="flex items-center justify-center">
          <div className="text-sm">
            Start by adding a mapping between an Assembly file channel and a Dropbox folder.
          </div>
        </div>
      </td>
    </tr>
  )
}

const MappingTableRow = () => {
  const {
    handleSyncStatusChange,
    handleItemRemove,
    openSyncConfirmDialog,
    onUserSelectorValueChange,
    filteredValue,
    onDropboxFolderChange,
    totalCountLoading,
  } = useTable()
  const { unselectedChannelList } = useUpdateUserList()
  const { isFolderTreeLoading } = useFolder()
  const { tempMapList, userChannelList, syncedPercentage, tempFolders } = useUserChannel()
  const { openConfirmDialog } = useRemoveChannelSync()
  const { resyncChannel } = useResyncChannel()

  if (isFolderTreeLoading) {
    return (
      <tr>
        <td colSpan={5} className="py-4">
          <Loader size={5} />
        </td>
      </tr>
    )
  }

  return (
    <>
      {tempMapList.length ? (
        tempMapList.map((mapItem, index) => (
          <tr key={mapItem?.id ?? mapItem?.tempId}>
            <td className="w-80 whitespace-nowrap px-6 py-2">
              <CopilotSelector
                name="File channel"
                initialValue={getCompanySelectorValue(
                  userChannelList,
                  mapItem.fileChannelValue?.[0],
                )}
                onChange={(val) => onUserSelectorValueChange(val, index)}
                disabled={!!mapItem?.id || mapItem.status === null}
                options={unselectedChannelList || {}}
              />
            </td>
            <td className="w-96 whitespace-nowrap px-6 py-2">
              <TreeSelect
                value={filteredValue?.[index] || mapItem.dbxRootPath}
                onChange={(val) => onDropboxFolderChange(val, index)}
                options={tempFolders || []}
                placeholder="Search Dropbox folder"
                disabled={!!mapItem?.id || mapItem.status === null}
              />
            </td>
            <td className="w-[150px] whitespace-nowrap px-6 py-2 text-gray-500 text-sm">
              {mapItem.resyncingAt ? (
                'Resyncing...'
              ) : mapItem.status && mapItem.lastSyncedAt ? (
                <LastSyncAt date={mapItem.lastSyncedAt} />
              ) : (
                '-'
              )}
            </td>
            <td className="w-[150px] whitespace-nowrap px-6 py-2">
              <div className="flex items-center gap-2">
                <MappingTableStatus
                  status={mapItem.status}
                  percentage={syncedPercentage?.[index] ?? mapItem.syncedPercentage ?? 0}
                />
              </div>
            </td>
            <td className="revert-svg w-64 whitespace-nowrap px-6 py-2">
              {mapItem.id && mapItem.status !== null ? (
                <div className="flex items-center gap-3">
                  {mapItem.status === true && (
                    <Button
                      label="Resync"
                      prefixIcon="Repeat"
                      size="sm"
                      variant="secondary"
                      onClick={() => resyncChannel(mapItem.id)}
                      disabled={!!mapItem.resyncingAt}
                    />
                  )}
                  <Button
                    label={`${mapItem.status ? 'Disconnect' : 'Enable'}`}
                    prefixIcon={`${mapItem.status ? 'Disconnect' : 'Repeat'}`}
                    size="sm"
                    variant="secondary"
                    onClick={() => handleSyncStatusChange(index)}
                  />
                  <Button
                    label="Remove"
                    prefixIcon="Trash"
                    size="sm"
                    variant="secondary"
                    onClick={() => openConfirmDialog(mapItem.id)}
                  />
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <Button
                    label={`${mapItem.status === null ? 'Syncing...' : 'Save'}`}
                    {...(mapItem.status !== null && { prefixIcon: 'Check' })}
                    size="sm"
                    variant="primary"
                    onClick={() => openSyncConfirmDialog(index)}
                    disabled={
                      totalCountLoading ||
                      !mapItem.dbxRootPath ||
                      !mapItem.fileChannelValue.length ||
                      mapItem.status === null
                        ? true
                        : mapItem.status
                    }
                    loading={totalCountLoading}
                  />
                  <Button
                    label="Discard"
                    prefixIcon="Close"
                    size="sm"
                    variant="secondary"
                    onClick={() => handleItemRemove(index)}
                    disabled={mapItem.status === null}
                  />
                </div>
              )}
            </td>
          </tr>
        ))
      ) : (
        <MappingTableNoRecords />
      )}
    </>
  )
}

export const MappingTable = () => {
  const columns = [
    { title: 'File Channel', key: 'fileChannel', className: 'w-80' },
    { title: 'Dropbox Folder', key: 'dropboxFolder', className: 'w-96' },
    { title: 'Last Updated', key: 'lastUpdated', className: 'w-[150px]' },
    { title: 'Status', key: 'status', className: 'w-[150px]' },
    { title: 'Actions', key: 'actions', className: 'w-64' },
  ]

  const { isOpen, onCancel, onConfirm, toggleDialog, title, description } = useDialogContext()

  return (
    <div className="m-10 mt-0 min-h-0 flex-1 overflow-x-auto">
      <div className="h-full w-full">
        <table className="w-full">
          <thead className="border border-gray-200 bg-gray-50">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  className={cn(
                    'px-6 py-3 text-left font-medium text-gray-500 text-xs uppercase',
                    column.className,
                  )}
                >
                  {column.title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 border border-gray-200 bg-white">
            <MappingTableRow />
          </tbody>
        </table>
      </div>
      {isOpen && (
        <Dialog
          open={isOpen}
          setOpen={toggleDialog}
          title={title}
          description={description}
          cancel={onCancel}
          confirm={() => onConfirm?.()}
        />
      )}
    </div>
  )
}
