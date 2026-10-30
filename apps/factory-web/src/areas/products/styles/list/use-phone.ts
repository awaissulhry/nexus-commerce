'use client'

import { useSyncExternalStore } from 'react'

/** Below 720 px the styles list is a card list (design products.styles sec:styles.phone; the studio's own phone width). */
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
