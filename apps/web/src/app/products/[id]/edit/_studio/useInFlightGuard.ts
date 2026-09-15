'use client'

import { useEffect, useId, useRef } from 'react'
import { registerProfileChanges } from '@/lib/workspaces/unsaved-changes'

import { leaveConfirmMessage, pendingWrites, shouldInterceptLeave } from './saveState'
import type { StudioSaveState } from './types'

type PublicationBlocker = (canChangeEditor?: () => boolean) => string | null

/**
 * Guards every way out of the studio using the workspace's live save verdict. Formula drafts and
 * refused writes can change inside a child editor without rerendering the provider, so listeners
 * must read `publicationBlocker` at event time instead of capturing the last render's save count.
 */
export function useInFlightGuard(
  state: StudioSaveState,
  publicationBlocker: PublicationBlocker,
  canChangeEditor: () => boolean,
): void {
  const profileGuardId = useId()
  const pendingRef = useRef(pendingWrites(state))
  pendingRef.current = pendingWrites(state)
  const publicationBlockerRef = useRef(publicationBlocker)
  publicationBlockerRef.current = publicationBlocker
  const canChangeEditorRef = useRef(canChangeEditor)
  canChangeEditorRef.current = canChangeEditor
  const currentBlocker = () => publicationBlockerRef.current(canChangeEditorRef.current)

  useEffect(() => registerProfileChanges(profileGuardId, {
    isDirty: () => currentBlocker() != null,
    canDiscard: () => false,
    discard: () => { throw new Error('Wait for or resolve product changes before switching profiles.') },
    save: async () => {
      const first = currentBlocker()
      if (!first) return
      if (pendingRef.current <= 0) throw new Error(first)

      const deadline = Date.now() + 30_000
      while (pendingRef.current > 0) {
        if (Date.now() > deadline) throw new Error('Product changes are still saving. Stay here and check their status before switching profiles.')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const remaining = currentBlocker()
      if (remaining) throw new Error(remaining)
    },
  }), [profileGuardId])

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!currentBlocker()) return
      e.preventDefault()
      // Modern browsers show their own wording; returnValue is what still arms the prompt.
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Let the operator's own modifiers through: a ⌘-click opens a new tab and leaves this one —
      // and its pending work — exactly where it is.
      const anchor = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      let dest: { origin: string; pathname: string } | null = null
      if (anchor) {
        try {
          const u = new URL(anchor.href, window.location.href)
          dest = { origin: u.origin, pathname: u.pathname }
        } catch {
          dest = null
        }
      }
      // Classify the click before consulting the live blocker. `canChangeEditor()` is allowed to
      // flush an idle field commit, so asking it about a Formula button, Cancel, a modified link or
      // a same-route scope link would mutate the editor before that control handles its own click.
      // `blocked: true` asks only the navigation/exemption half of the shared rule.
      if (
        !shouldInterceptLeave({
          pending: 0,
          blocked: true,
          defaultPrevented: e.defaultPrevented,
          button: e.button,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          anchorTarget: anchor?.target || null,
          href: anchor ? (anchor.getAttribute('href') ?? '') : null,
          dest,
          currentOrigin: window.location.origin,
          currentPathname: window.location.pathname,
        })
      ) return

      const blocker = currentBlocker()
      if (!blocker) return
      const ok = window.confirm(leaveConfirmMessage(pendingRef.current, blocker))
      if (!ok) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    // Capture phase: Next's Link handles the click on bubble, so a listener there would run too late.
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])
}
