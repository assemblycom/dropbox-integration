import z from 'zod'
import type { PageProps } from '@/app/(home)/types'
import { CheckConnection } from '@/components/layouts/CheckConnection'
import { AppBridge } from '@/features/app-bridge/components/AppBridge'
import { Callout } from '@/features/auth/components/Callout'
import { RealtimeDropboxConnections } from '@/features/auth/components/RealtimeDropboxConnections'
import { AuthContextProvider } from '@/features/auth/context/AuthContext'
import DropboxConnectionsService from '@/features/auth/lib/DropboxConnections.service'
import { disconnectDropbox } from '@/features/auth/utils/dropboxConnections'
import { RealtimeSync } from '@/features/sync/components/RealtimeSync'
import { SubHeader } from '@/features/sync/components/SubHeader'
import { MappingTable } from '@/features/sync/components/Table'
import { DialogContextProvider } from '@/features/sync/context/DialogContext'
import { UserChannelContextProvider } from '@/features/sync/context/UserChannelContext'
import { MapFilesService } from '@/features/sync/lib/MapFiles.service'
import { UserService } from '@/features/sync/lib/User.service'
import type { MapList } from '@/features/sync/types'
import { serializeClientUser } from '@/lib/copilot/models/ClientUser.model'
import User from '@/lib/copilot/models/User.model'
import { getWorkspace } from '@/utils/workspace'

const Home = async ({ searchParams }: PageProps) => {
  const sp = await searchParams
  const user = await User.authenticate(sp.token)
  const token = z.string().parse(sp.token)
  const clientUser = serializeClientUser(user)

  const dpxConnectionService = new DropboxConnectionsService(user)
  const connection = await dpxConnectionService.getConnectionForWorkspace()

  const userService = new UserService(user)

  // Fetch user data, workspace, and channel maps in parallel
  const mapListPromise =
    connection.refreshToken && connection.accountId
      ? new MapFilesService(user, {
          refreshToken: connection.refreshToken,
          accountId: connection.accountId,
          rootNamespaceId: connection.rootNamespaceId,
        }).listFormattedChannelMap()
      : Promise.resolve([] as MapList[])

  const [users, workspace, mapList] = await Promise.all([
    userService.getSelectorClientsCompanies(),
    getWorkspace(token),
    mapListPromise,
  ])

  const tempMapList = structuredClone(mapList)

  return (
    <AuthContextProvider user={clientUser} connectionStatus={connection.status}>
      <RealtimeDropboxConnections user={clientUser} />
      <Callout />
      <UserChannelContextProvider
        userChannelList={users}
        mapList={mapList}
        tempMapList={tempMapList}
      >
        <RealtimeSync user={clientUser} />
        <CheckConnection>
          <AppBridge
            handleDropboxDisconnection={async () => {
              'use server'
              await disconnectDropbox(token)
            }}
            portalUrl={workspace.portalUrl}
          />
          <SubHeader />
          <DialogContextProvider>
            <MappingTable />
          </DialogContextProvider>
        </CheckConnection>
      </UserChannelContextProvider>
    </AuthContextProvider>
  )
}

export default Home
