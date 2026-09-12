'use client'

import { useEffect, useRef } from 'react'

interface PresentationNavigateEvent extends Event {
  destination: { url: string; key?: string }
  navigationType: 'push' | 'replace' | 'traverse' | 'reload'
}
interface PresentationNavigation extends EventTarget { traverseTo: (key: string) => unknown }

/** Uses the editor's existing in-panel discard confirmation for links, Back/Forward and
 * programmatic history navigation. Browser-owned unload confirmation covers document exits.
 * Guard before Next’s history wrapper dispatches its React update. Wrappers are restored only
 * when still owned here; an inactive wrapper captured by another caller becomes transparent. */
export function installPresentationNavigationGuard(win: Window, mayLeave: () => Promise<boolean>) {
  const navigation = (win as Window & { navigation?: PresentationNavigation }).navigation
  let allowed = false, asking = false, alive = true
  const leave = async (resume: () => void) => {
    if (asking) return
    asking = true
    try {
      if (!await mayLeave() || !alive) return
      allowed = true
      resume()
    } finally { asking = false }
  }
  const beforeUnload = (event: BeforeUnloadEvent) => { if (!allowed) { event.preventDefault(); event.returnValue = '' } }
  const onNavigate = (event: Event) => {
    const e = event as PresentationNavigateEvent
    if (allowed || e.defaultPrevented || !e.cancelable || e.destination.url === win.location.href) return
    e.preventDefault()
    void leave(() => {
      if (e.navigationType === 'traverse' && e.destination.key && navigation) navigation.traverseTo(e.destination.key)
      else win.location.assign(e.destination.url)
    })
  }
  const onClick = (event: MouseEvent) => {
    if (allowed || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!anchor || anchor.download || (anchor.target && anchor.target !== '_self') || anchor.href === win.location.href) return
    event.preventDefault(); event.stopPropagation()
    void leave(() => win.location.assign(anchor.href))
  }
  // Next's installed pushState/replaceState dispatch their state restore BEFORE native
  // history emits `navigate`. Cancelling that event alone leaves the URL in place while React
  // unmounts the draft. Stop the call before it reaches that installed wrapper.
  const restores: Array<() => void> = []
  if (win.history) for (const method of ['pushState', 'replaceState'] as const) {
    const previous = win.history[method]
    const guarded: History[typeof method] = function (data, unused, url) {
      if (!alive || allowed || url == null || new URL(String(url), win.location.href).href === win.location.href) return previous.call(win.history, data, unused, url)
      void leave(() => {
        try { previous.call(win.history, data, unused, url) }
        // Native history dispatches `navigate` synchronously. Permit that one event, then
        // protect any later request if the URL change leaves this editor mounted.
        finally { allowed = false }
      })
    }
    win.history[method] = guarded
    restores.push(() => { if (win.history[method] === guarded) win.history[method] = previous })
  }
  win.addEventListener('beforeunload', beforeUnload)
  win.document.addEventListener('click', onClick, true)
  navigation?.addEventListener('navigate', onNavigate)
  return () => { alive = false; restores.forEach(restore => restore()); win.removeEventListener('beforeunload', beforeUnload); win.document.removeEventListener('click', onClick, true); navigation?.removeEventListener('navigate', onNavigate) }
}

export function usePresentationNavigationGuard(pending: boolean, mayLeave: () => Promise<boolean>) {
  const callback = useRef(mayLeave); callback.current = mayLeave
  useEffect(() => pending ? installPresentationNavigationGuard(window, () => callback.current()) : undefined, [pending])
}
