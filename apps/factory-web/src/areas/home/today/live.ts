'use client'

import { useEffect, useRef, useState } from 'react'
import { parseLiveData } from '../../../record-panels/live'
import type { LiveState } from './model'

/**
 * Today's live channel (GET /live through this app's `/api`): one EventSource while the page is open. A `change`
 * whose type one of the page's sections named (`live.events`) is a HINT to read that section again; after a break the
 * page reads everything again (nothing is replayed). The band says where the channel stands: connecting, live, offline.
 */
export function useTodayLive(handlers: { onChange: (type: string) => void; onReconnect: () => void }, enabled: boolean): LiveState {
  const latest = useRef(handlers)
  latest.current = handlers
  const [state, setState] = useState<LiveState>('connecting')
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') {
      setState('offline')
      return
    }
    const source = new EventSource('/api/live')
    let readyOnce = false
    const onReady = () => {
      setState('live')
      if (readyOnce) latest.current.onReconnect()
      readyOnce = true
    }
    const onChange = (event: MessageEvent<string>) => {
      const change = parseLiveData(event.data)
      if (change) latest.current.onChange(change.type)
    }
    // The browser reconnects by itself; until `ready` comes again the page says it is offline.
    const onError = () => setState('offline')
    source.addEventListener('ready', onReady)
    source.addEventListener('change', onChange as EventListener)
    source.addEventListener('error', onError)
    return () => {
      source.removeEventListener('ready', onReady)
      source.removeEventListener('change', onChange as EventListener)
      source.removeEventListener('error', onError)
      source.close()
    }
  }, [enabled])
  return state
}
