'use client'

import { useSyncExternalStore } from 'react'

const subscribe = () => () => {}
const onClient = () => true
const onServer = () => false

/**
 * False on the server and during the first (hydration) render, true after it. A part that exists only in the browser
 * — a portal into `document.body`, a time in the viewer's locale — draws it only when this is true, so the first render
 * matches the server's HTML. A plain `typeof document` check does not: a dialog that is open when the page loads (a lab
 * tab, a link that opens one) drew nothing on the server and the whole dialog on the first render, and React threw a
 * hydration error (#418). After hydration this is true at once, so a dialog opened by a click draws on that click.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, onClient, onServer)
}
