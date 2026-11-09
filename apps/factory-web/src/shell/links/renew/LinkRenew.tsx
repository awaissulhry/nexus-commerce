'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { askForNewLink } from './api'
import { LinkRenewContext } from './context'
import { renewFailure, type RenewState } from './model'

/**
 * B-W2b-169: holds "Ask for a new link" for the link the landing opened (`api` carries its token; null: no token, no
 * button). One ask at a time; once answered it stays done (pressed once → held); a wait ends by itself when its time
 * passes. Keyed by the landing on the client, so a link pasted into the same tab starts again.
 */
export function LinkRenewProvider({ api, children }: { api: ApiClient | null; children?: ReactNode }) {
  const [state, setState] = useState<{ state: RenewState; waitUntil: string | null }>({ state: 'idle', waitUntil: null })
  const current = useRef(state)
  current.current = state

  const ask = useCallback(() => {
    if (!api) return
    const now = current.current.state
    if (now === 'busy' || now === 'checking' || now === 'done' || now === 'wait') return
    setState({ state: 'busy', waitUntil: null })
    askForNewLink(api, () => setState({ state: 'checking', waitUntil: null }))
      .then(() => setState({ state: 'done', waitUntil: null }))
      .catch((error: unknown) => setState(renewFailure(error, new Date())))
  }, [api])

  // A wait passes by itself: the button acts again.
  useEffect(() => {
    if (state.state !== 'wait' || !state.waitUntil) return
    const timer = setTimeout(() => setState({ state: 'idle', waitUntil: null }), Math.max(0, Date.parse(state.waitUntil) - Date.now()))
    return () => clearTimeout(timer)
  }, [state])

  const value = useMemo(() => (api ? { state: state.state, waitUntil: state.waitUntil, ask } : null), [api, state, ask])
  return <LinkRenewContext.Provider value={value}>{children}</LinkRenewContext.Provider>
}
