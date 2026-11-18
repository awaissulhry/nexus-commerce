'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useLiveChanges } from '../../../../record-panels/live'
import { readCustomerFeed } from './api'
import {
  afterFirst,
  afterFresh,
  afterOlder,
  audienceOfView,
  EMPTY_FEED,
  feedModel,
  kindsOfChoice,
  liveTouches,
  showFresh,
  type AllOfCustomerModel,
  type FeedKindChoice,
  type FeedState,
  type FeedView,
} from './model'

/** Live hints are folded into one re-read of the newest page (the lists' and the strip's pace, review C-18). */
export const FRESH_WAIT_MS = 800

export interface AllOfCustomerActions {
  readonly onView: (view: FeedView) => void
  readonly onKind: (kind: FeedKindChoice) => void
  /** "N new · Show": the waiting messages on top. */
  readonly onShowNew: () => void
  /** Show older: the next page at the foot. */
  readonly onOlder: () => void
  /** Try again after a failed read. */
  readonly onRetry: () => void
}

/**
 * F-SA-261 (sales page plan R4, P9) — the container of "All of <Customer>": reads the customer's merged feed while it is shown
 * (`enabled`), page by page; re-reads the newest page in the background on a live hint about a customer-side conversation (folded,
 * 800 ms) and keeps what is newer behind "N new · Show" — the list never moves by itself; View ▾ and Kind ▾ read the first page
 * again. It never marks anything read and writes nothing. The host draws `AllOfCustomerFeed` with the model and the actions, plus
 * its own doors (`onAnswer`: switch the dock to that conversation).
 */
export function useAllOfCustomer(
  api: ApiClient,
  input: { readonly partyId: string | null; readonly customerName: string; readonly enabled: boolean; readonly prefix: string; readonly canReadFiles: boolean },
): { model: AllOfCustomerModel; actions: AllOfCustomerActions; state: FeedState } {
  const { partyId, enabled } = input
  const [state, setState] = useState<FeedState>(EMPTY_FEED)
  const [view, setView] = useState<FeedView>('all')
  const [kind, setKind] = useState<FeedKindChoice>('every')
  // Each read knows its turn: an answer of an older View, Kind or customer never lands on a newer list.
  const turn = useRef(0)
  const freshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const query = useMemo(() => ({ audience: audienceOfView(view), kinds: kindsOfChoice(kind) }), [view, kind])
  const stateRef = useRef(state)
  stateRef.current = state

  const loadFirst = useCallback(() => {
    if (!partyId) return
    const mine = ++turn.current
    // A new View or Kind starts its own list: the lines of the last one never stand under the new filter.
    setState((now) => ({ ...now, status: 'loading', entries: [], cursor: null, older: 'idle', fresh: null }))
    readCustomerFeed(api, partyId, query)
      .then((answer) => mine === turn.current && setState((now) => afterFirst(now, answer)))
      .catch((error: unknown) => mine === turn.current && setState((now) => ({ ...now, status: isApiError(error) && (error.kind === 'not_found' || error.kind === 'forbidden') ? 'gone' : 'failed' })))
  }, [api, partyId, query])

  useEffect(() => {
    if (enabled) loadFirst()
  }, [enabled, loadFirst])

  const loadOlder = useCallback(() => {
    const now = stateRef.current
    if (!partyId || !now.cursor || now.older === 'loading') return
    const mine = turn.current
    setState((current) => ({ ...current, older: 'loading' }))
    readCustomerFeed(api, partyId, { ...query, cursor: now.cursor })
      .then((answer) => mine === turn.current && setState((current) => afterOlder(current, answer)))
      .catch(() => mine === turn.current && setState((current) => ({ ...current, older: 'failed' })))
  }, [api, partyId, query])

  const loadFresh = useCallback(() => {
    if (!partyId || stateRef.current.status !== 'ready') return
    const mine = turn.current
    readCustomerFeed(api, partyId, query)
      .then((answer) => mine === turn.current && setState((current) => afterFresh(current, answer)))
      .catch(() => undefined) // a hint missed: the next one, or a reconnect, reads again
  }, [api, partyId, query])

  const scheduleFresh = useCallback(() => {
    if (freshTimer.current) return
    freshTimer.current = setTimeout(() => {
      freshTimer.current = null
      loadFresh()
    }, FRESH_WAIT_MS)
  }, [loadFresh])

  useEffect(
    () => () => {
      if (freshTimer.current) clearTimeout(freshTimer.current)
      freshTimer.current = null
    },
    [],
  )

  useLiveChanges({ onChange: (change) => liveTouches(change) && scheduleFresh(), onReconnect: scheduleFresh }, enabled && partyId !== null)

  const actions: AllOfCustomerActions = {
    onView: (next) => setView(next),
    onKind: (next) => setKind(next),
    onShowNew: () => setState(showFresh),
    onOlder: loadOlder,
    onRetry: loadFirst,
  }
  const model = feedModel(state, { customerName: input.customerName, prefix: input.prefix, view, kind, canReadFiles: input.canReadFiles })
  return { model, actions, state }
}
