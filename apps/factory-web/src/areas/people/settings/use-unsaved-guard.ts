'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Leaving with edits (design D9 useUnsavedGuard: not in the DS yet, composed here and named): while `dirty`, the browser asks
 * before it closes the tab, and a click on a link of this app waits for Save · Discard · Stay (`pending` = where it was
 * going). A link that opens a new tab leaves the page alone.
 */
export function useUnsavedGuard(dirty: boolean): { pending: string | null; stay: () => void } {
  const [pending, setPending] = useState<string | null>(null)
  const held = useRef(dirty)
  held.current = dirty

  useEffect(() => {
    if (!dirty) return
    const onLeave = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [dirty])

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!held.current || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
      const link = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!link || link.target === '_blank') return
      const to = new URL(link.href, window.location.href)
      if (to.origin !== window.location.origin || (to.pathname === window.location.pathname && to.search === window.location.search)) return
      event.preventDefault()
      event.stopPropagation()
      setPending(`${to.pathname}${to.search}${to.hash}`)
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  return { pending, stay: () => setPending(null) }
}
