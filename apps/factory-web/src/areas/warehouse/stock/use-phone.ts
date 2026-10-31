'use client'

import { useSyncExternalStore } from 'react'

/** Below 720 px Stock is a card list (design warehouse.stock sec:st-phone: "the same rows as cards below 720 px"). */
export const PHONE_LIST_QUERY = '(max-width: 719px)'

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => undefined
  const query = window.matchMedia(PHONE_LIST_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/** True on a phone-width screen; the server and the first client render draw the grid. */
export function usePhoneList(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia(PHONE_LIST_QUERY).matches,
    () => false,
  )
}
