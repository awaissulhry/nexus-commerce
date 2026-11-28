'use client'

import { useCallback, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import type { Locale } from '../../../../lib/i18n/locales'
import { productRowsOf } from '../../../../lib/order-draft/model'
import type { DraftRecord } from '../../../../lib/order-draft/schema'
import { readStyle, type StyleDetail } from '../../inquiries/api'
import type { ConfirmAnswer, ConfirmBody } from './api'
import { confirmBodyOf, confirmHeldOf, confirmRowsOf, productHeldOf, promiseProblemOf, promiseStartOf, type ConfirmEntry } from './confirm-model'

/** The Confirm window's state: each row's entry, the promised day, a send running, its refusal in words. */
export interface ConfirmState {
  entries: Record<string, ConfirmEntry>
  /** owb-of5 step 4: the promised day (YYYY-MM-DD; empty until typed). */
  promise: string
  busy: boolean
  failed: string | null
}

export interface ConfirmActions {
  onOpen?: () => void
  onStyle?: (rowId: string, styleId: string) => void
  onEntry?: (rowId: string, patch: Partial<ConfirmEntry>) => void
  onPromise?: (value: string) => void
  onSend?: () => void
  onClose?: () => void
}

/**
 * owb-of5 step 4 — the ONE Confirm window's state and its send (THE SIMPLE ORDER START od-w2.2, now with the promised day): the draft
 * page, the orders sheet and Incoming open the same window (ConfirmOrderWindow), each through this hook. `send` is the host's door
 * (today's `POST /sales/order-requests/:id/confirm`: send if still a draft + accept, the body's `promiseDate`); nothing is sent while a
 * line has no product (A-5), the promised day is empty or past, or a row still needs its colour or pieces (the stops of today, L1).
 */
export function useConfirmOrder(input: { api: ApiClient; record: DraftRecord | null; locale: Locale; today: string; send: (body: Omit<ConfirmBody, 'version'>) => Promise<ConfirmAnswer>; onDone: (made: ConfirmAnswer['made']) => void }): { state: ConfirmState | null; details: Readonly<Record<string, StyleDetail>>; actions: ConfirmActions } {
  const { api, record, locale, today, send, onDone } = input
  const [state, setState] = useState<ConfirmState | null>(null)
  const [details, setDetails] = useState<Record<string, StyleDetail>>({})
  const latest = useRef({ record, state, send, onDone })
  latest.current = { record, state, send, onDone }

  const onOpen = useCallback(() => {
    const current = latest.current.record
    if (!current) return
    const entries = Object.fromEntries(confirmRowsOf(productRowsOf(current.request, locale)).map((entry) => [entry.rowId, entry]))
    setState({ entries, promise: promiseStartOf(current.request.requestedDate, today), busy: false, failed: null })
  }, [locale, today])

  const onStyle = useCallback(
    (rowId: string, styleId: string) => {
      setState((now) => (now ? { ...now, entries: { ...now.entries, [rowId]: { ...now.entries[rowId]!, styleId: styleId || null, colourwayId: null } } } : now))
      if (styleId)
        readStyle(api, styleId)
          .then((detail) => setDetails((now) => ({ ...now, [styleId]: detail })))
          .catch(() => undefined)
    },
    [api],
  )

  const onSend = useCallback(() => {
    const { record: current, state: now, send: door, onDone: done } = latest.current
    if (!current || !now || now.busy) return
    const rows = productRowsOf(current.request, locale)
    if (productHeldOf(rows, now.entries) || promiseProblemOf(now.promise, today) || confirmHeldOf(rows, now.entries)) return
    const body: Omit<ConfirmBody, 'version'> = { ...confirmBodyOf(rows, now.entries, current.seesPrices), promiseDate: now.promise.trim() }
    setState({ ...now, busy: true, failed: null })
    door(body).then(
      (answer) => {
        setState(null)
        done(answer.made)
      },
      (error: unknown) => setState((then) => (then ? { ...then, busy: false, failed: isApiError(error) && error.message ? error.message : 'cf.failed' } : then)),
    )
  }, [locale, today])

  return {
    state,
    details,
    actions: {
      onOpen,
      onStyle,
      onEntry: (rowId, patch) => setState((now) => (now ? { ...now, entries: { ...now.entries, [rowId]: { ...now.entries[rowId]!, ...patch } } } : now)),
      onPromise: (value) => setState((now) => (now ? { ...now, promise: value } : now)),
      onSend,
      onClose: () => setState((now) => (now?.busy ? now : null)),
    },
  }
}
