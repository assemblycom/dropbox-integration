import { useAuthContext } from '@auth/hooks/useAuth'
import type { ClientUser } from '@/lib/copilot/models/ClientUser.model'
import { useRealtime } from '@/lib/supabase/hooks/useRealtime'

// Curated broadcast payload built by broadcast_dropbox_connection_status().
type DropboxConnectionStatusBroadcast = {
  id: string
  portal_id: string
  status: boolean
}

export const useRealtimeDropboxConnections = (user: ClientUser) => {
  const { updateAuth } = useAuthContext()

  return useRealtime<DropboxConnectionStatusBroadcast>(
    `dropbox_connection:${user.portalId}`,
    'connection_update',
    (payload) => {
      updateAuth({ connectionStatus: payload.status })
    },
  )
}
