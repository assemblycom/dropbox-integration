'use client'

import { useEffect, useMemo, useRef } from 'react'
import getSupabaseClient from '@/lib/supabase/SupabaseClient'

/**
 * Subscribes to a DB-emitted Supabase Broadcast topic. The channel name MUST
 * equal the topic the trigger's realtime.send() targets.
 */
export const useRealtime = <TPayload,>(
  topic: string,
  event: string,
  onMessage: (payload: TPayload) => unknown,
) => {
  const supabase = useMemo(() => getSupabaseClient(), [])
  const latestCallback = useRef<typeof onMessage>(onMessage)

  useEffect(() => {
    latestCallback.current = onMessage
  }, [onMessage])

  useEffect(() => {
    if (!topic) return

    const channel = supabase
      .channel(topic, { config: { private: true } })
      .on(
        // biome-ignore lint/suspicious/noExplicitAny: broadcast event typing is loose in supabase-js
        'broadcast' as any,
        { event },
        (message: { payload: TPayload }) => {
          latestCallback.current(message.payload)
        },
      )
      .subscribe()

    return () => {
      void channel.unsubscribe()
    }
  }, [supabase, topic, event])
}
