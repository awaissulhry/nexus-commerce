'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import type { Locale } from '../../../../lib/i18n/locales'
import { usePortalUnsaved } from '../../../shell/frame'
import { fetchPointerSources, reportProblem, type ProblemAnswer } from './api'
import { pointerOptionsOf, problemBodyOf, problemFailure, problemHeld, problemOrdersOf, problemOutcomeOf, type PointerOption, type ProblemOrder } from './model'
import type { ReportProblemActions, ReportProblemModel } from './view/ReportProblemDialog'

/**
 * F-PR-24 — the "Report a problem" dialog's container, ONE for every page that opens it (the order page: its band ⋯ and Status &
 * progress; My production: a row's ⋯; the bulk bar's More, F-PR-23a): `open(orders)` with one or more of the customer's own orders
 * (each by its own name), the text, for ONE order what it is about (a file we shared, a message of its conversation — read only
 * then), Send = ONE request (B-PR-45: one message in each order's thread) with one Idempotency-Key kept while the same report is
 * sent again — Retry after a lost answer never writes a second message. The text is kept when it did not go, and when the dialog
 * is closed and opened again on the same orders. While text waits unsent, leaving the page asks first (the frame's guard).
 */

export interface ReportProblemSetup {
  readonly api: ApiClient
  readonly locale: Locale
  readonly t: (key: string, params?: Readonly<Record<string, string | number>>) => string
  readonly writers: { readonly day: (iso: string) => string; readonly at: (iso: string) => string }
  readonly facts: {
    readonly preview: boolean
    readonly offline: boolean
    /** portal.comment: the person writes in its orders' conversations. */
    readonly mayWrite: boolean
    /** portal.customerDocuments.view: the files we shared may be pointed to. */
    readonly seesFiles: boolean
    /** threads.read: a message of the order's conversation may be pointed to. */
    readonly seesMessages: boolean
  }
  /** After a report went (the page reads its production again: the chip says "Waiting on us since …"). */
  readonly onSent?: (answer: ProblemAnswer) => void
}

type Pointers = { readonly state: 'loading' | 'error' | 'ready'; readonly options: readonly PointerOption[] }
interface DialogState {
  readonly orders: readonly ProblemOrder[]
  readonly text: string
  readonly pointerId: string | null
  /** Null: many orders (no pointer: "Pick one order to point to a file or a message"). */
  readonly pointers: Pointers | null
  readonly phase: 'edit' | 'sending' | 'failed' | 'done'
  readonly failure: { readonly key: string; readonly retry: boolean } | null
  readonly answer: ProblemAnswer | null
}

const keyOfOrders = (orders: readonly ProblemOrder[]): string => orders.map((order) => order.id).join(',')

export function useReportProblem(setup: ReportProblemSetup): { readonly model: ReportProblemModel | null; readonly open: (orders: readonly ProblemOrder[]) => void; readonly actions: ReportProblemActions } {
  const { api, locale, t, writers, facts, onSent } = setup
  const [state, setState] = useState<DialogState | null>(null)
  // A text not sent, kept for the same orders when the dialog closes (opened again: it is there).
  const kept = useRef<{ orders: string; text: string; pointerId: string | null } | null>(null)
  const writeKey = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown): string => {
    const text = JSON.stringify(body)
    if (writeKey.current?.body !== text) writeKey.current = { body: text, key: newIdempotencyKey() }
    return writeKey.current.key
  }
  const reading = useRef<AbortController | null>(null)

  const loadPointers = useCallback(
    (orderId: string) => {
      reading.current?.abort()
      const control = new AbortController()
      reading.current = control
      setState((current) => (current ? { ...current, pointers: { state: 'loading', options: current.pointers?.options ?? [] } } : current))
      fetchPointerSources(api, orderId, { files: facts.seesFiles, messages: facts.seesMessages }, control.signal)
        .then((sources) => {
          if (control.signal.aborted) return
          const options = pointerOptionsOf(sources, locale, t, writers)
          setState((current) => (current ? { ...current, pointers: { state: 'ready', options }, pointerId: current.pointerId && options.some((option) => option.id === current.pointerId) ? current.pointerId : null } : current))
        })
        .catch(() => {
          if (control.signal.aborted) return
          setState((current) => (current ? { ...current, pointers: { state: 'error', options: [] } } : current))
        })
    },
    [api, facts.seesFiles, facts.seesMessages, locale, t, writers],
  )

  const open = useCallback(
    (picked: readonly ProblemOrder[]) => {
      const { orders } = problemOrdersOf(picked)
      const again = kept.current && kept.current.orders === keyOfOrders(orders) ? kept.current : null
      writeKey.current = null
      const one = orders.length === 1 && (facts.seesFiles || facts.seesMessages)
      setState({ orders, text: again?.text ?? '', pointerId: again?.pointerId ?? null, pointers: one ? { state: 'loading', options: [] } : null, phase: 'edit', failure: null, answer: null })
      if (one) loadPointers(orders[0]!.id)
    },
    [facts.seesFiles, facts.seesMessages, loadPointers],
  )

  const pointer = state?.pointers?.options.find((option) => option.id === state.pointerId) ?? null
  const over = state ? problemOrdersOf(state.orders).over : 0
  const held = state ? problemHeld({ ...facts, sending: state.phase === 'sending' }, { orders: state.orders, over, text: state.text, pointer }) : null

  const send = () => {
    if (!state || state.phase === 'sending' || state.phase === 'done' || held) return
    const body = { orderIds: state.orders.map((order) => order.id), body: problemBodyOf(state.text, pointer) }
    const sentFor = keyOfOrders(state.orders)
    setState({ ...state, phase: 'sending', failure: null })
    reportProblem(api, body, keyFor(body))
      .then((answer) => {
        kept.current = null
        writeKey.current = null
        setState((current) => (current && keyOfOrders(current.orders) === sentFor ? { ...current, phase: 'done', answer } : current))
        onSent?.(answer)
      })
      // Not sent: the text stays; a moment's failure offers Retry (the same key: never a second message).
      .catch((error: unknown) => setState((current) => (current && keyOfOrders(current.orders) === sentFor ? { ...current, phase: 'failed', failure: problemFailure(error) } : current)))
  }

  const close = () => {
    if (!state || state.phase === 'sending') return
    reading.current?.abort()
    kept.current = state.phase === 'done' || state.text.trim() === '' ? null : { orders: keyOfOrders(state.orders), text: state.text, pointerId: state.pointerId }
    setState(null)
  }

  // Unsent words are not lost by leaving the page without a word (the frame asks Save / Discard / Stay).
  const dirty = state !== null && state.phase !== 'done' && state.text.trim() !== ''
  usePortalUnsaved('report-problem', { dirty, what: t('problem.unsaved') })

  const model = useMemo((): ReportProblemModel | null => {
    if (!state) return null
    return {
      orders: state.orders,
      over,
      text: state.text,
      pointer: state.pointers ? { state: state.pointers.state, options: state.pointers.options, chosen: state.pointerId } : null,
      pointerAsked: facts.seesFiles || facts.seesMessages,
      phase: state.phase,
      failure: state.failure,
      held: held ? t(held.key, held.params) : null,
      outcome: state.answer ? problemOutcomeOf(state.answer, state.orders, locale, t) : null,
    }
  }, [state, over, held, facts.seesFiles, facts.seesMessages, locale, t])

  const actions: ReportProblemActions = {
    onText: (text) => setState((current) => (current && current.phase !== 'sending' && current.phase !== 'done' ? { ...current, text, ...(current.phase === 'failed' ? { phase: 'edit' as const, failure: null } : {}) } : current)),
    onPointer: (id) => setState((current) => (current && current.phase !== 'sending' ? { ...current, pointerId: id } : current)),
    onRetryPointers: () => (state && state.orders.length === 1 ? loadPointers(state.orders[0]!.id) : undefined),
    onSend: send,
    onClose: close,
  }

  return { model, open, actions }
}
