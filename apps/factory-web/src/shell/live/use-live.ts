'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { liveBus, type LiveChange, type LiveState } from './bus'

export type { LiveChange, LiveState } from './bus'

/**
 * B-W2b-05 (COL-077): a screen listens to the tab's ONE live connection (bus.ts) while it is open (and `enabled`).
 * `onChange` gets every hint the person may see; `onReconnect` asks the screen to read everything again (after a break,
 * and by the tab's one fallback poll while the stream is down). Returns the stream's state in words.
 */
export function useLiveBus(handlers: { onChange?: (change: LiveChange) => void; onReconnect?: () => void }, enabled = true): LiveState {
  const latest = useRef(handlers)
  latest.current = handlers
  useEffect(() => {
    if (!enabled) return
    return liveBus().subscribe({
      onChange: (change) => latest.current.onChange?.(change),
      onResync: () => latest.current.onReconnect?.(),
    })
  }, [enabled])
  return useLiveState()
}

/** The tab's live state (the frame's status, a page's band): connecting, live, offline. The server renders `connecting`. */
export function useLiveState(): LiveState {
  return useSyncExternalStore(
    (onState) => liveBus().watch(onState),
    () => liveBus().state(),
    () => 'connecting',
  )
}
