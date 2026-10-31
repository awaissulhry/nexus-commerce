'use client'

import { useLiveBus } from '../../../shell/live/use-live'
import type { LiveState } from './model'

/**
 * Today's live channel (GET /live through this app's `/api`; the tab's one connection, B-W2b-05). A `change`
 * whose type one of the page's sections named (`live.events`) is a HINT to read that section again; after a break the
 * page reads everything again (nothing is replayed). The band says where the channel stands: connecting, live, offline.
 */
export function useTodayLive(handlers: { onChange: (type: string) => void; onReconnect: () => void }, enabled: boolean): LiveState {
  // B-W2b-05: the tab's ONE live connection (shell/live/bus.ts), shared with the bell and every other screen.
  return useLiveBus({ onChange: (change) => handlers.onChange(change.type), onReconnect: handlers.onReconnect }, enabled)
}
