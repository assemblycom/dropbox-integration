'use client'

import { REALTIME_LISTEN_TYPES } from '@supabase/supabase-js'
import { useEffect, useMemo, useRef } from 'react'
import getSupabaseClient from '@/lib/supabase/SupabaseClient'

/**
 * Subscribes to a DB-emitted Supabase Broadcast topic. The channel name MUST
 * equal the topic the trigger's realtime.send() targets.
 */
export const useRealtime = <TPayload extends Record<string, unknown>>(
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
      .on<TPayload>(REALTIME_LISTEN_TYPES.BROADCAST, { event }, (message) => {
        latestCallback.current(message.payload)
      })
      .subscribe()

    return () => {
      void channel.unsubscribe()
    }
  }, [supabase, topic, event])
}
