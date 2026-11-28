'use client'

import { useSyncExternalStore } from 'react'
import { undoStore } from './store'

/** owb-fl6: a count that moves each time an Undo went through: a screen that shows baskets reads again on it. */
export function useUndoChanges(): number {
  return useSyncExternalStore(
    undoStore.subscribe,
    () => undoStore.getSnapshot().changes,
    () => 0,
  )
}
