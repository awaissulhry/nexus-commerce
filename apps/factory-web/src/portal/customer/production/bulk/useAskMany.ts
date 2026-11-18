'use client'

import { useEffect, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import type { Locale } from '../../../../lib/i18n/locales'
import { fetchImpact, fetchRules, type ChangeRules, type ImpactRead } from '../../orders/api'
import type { ProductionRow } from '../api'
import type { AskManyReviewActions, AskManyReviewModel } from '../view/AskManyReview'
import { askMany, BULK_REASON_MAX, withdrawAskBatch, type BulkAskKind } from './api'
import {
  askBodyOf,
  askFormProblem,
  askHeldOf,
  askManyBodyOf,
  askRefusalOf,
  askResultsOf,
  askReviewOf,
  askRowNamesOf,
  askSaveOf,
  askTitleOf,
  askVerdictOf,
  cancelReasonsOf,
  EMPTY_ASK_FORM,
  type AskForm,
  type AskReview,
} from './ask-model'
import { ASK_MENU, askKindsOf, doneLineOf, undoLineOf, undoProblemOf, type RowResult } from './model'

/**
 * F-PR-23b — the container of Ask N on My production: the kinds Ask ▾ offers (one read of the rules of a picked order: the limits
 * are the customer's), then for the kind chosen each picked order's own rules (four at a time), the ask's fields, the impact of
 * each order that may be asked once the fields are filled in (four at a time, read again when they change), ONE request per order
 * of ONE batch with one Idempotency-Key kept while the same thing is sent again, the result per row, and Undo (the batch's requests
 * that still wait are withdrawn).
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

export interface AskSetup {
  readonly api: ApiClient
  readonly locale: Locale
  readonly t: Translate
  /** The order page's words (`portal-orders`): verdicts and impact, as F-PR-13's dialog says them. */
  readonly tOrders: Translate
  readonly day: (iso: string) => string
  readonly money: (minor: number, currency: string) => string
  readonly facts: { readonly preview: boolean; readonly offline: boolean }
  readonly onChanged: () => void
  readonly onDone: () => void
}

type Read<T> = { readonly state: 'loading' | 'error' | 'ready'; readonly value: T | null }

interface AskState {
  readonly kind: BulkAskKind
  readonly rows: readonly { readonly id: string; readonly name: string; readonly now: string }[]
  readonly rules: Readonly<Record<string, Read<ChangeRules>>>
  readonly form: AskForm
  /** The impacts read for `impactKey` (the form as it was then). */
  readonly impacts: Readonly<Record<string, Read<ImpactRead>>>
  readonly impactKey: string | null
  readonly phase: 'ready' | 'saving' | 'done'
  readonly sent: AskReview | null
  readonly results: Readonly<Record<string, RowResult>> | null
  readonly counts: { readonly asked: number; readonly not: number } | null
  readonly batchId: string | null
  readonly problem: string | null
  readonly undo: 'idle' | 'busy' | 'done'
  readonly undoLine: string | null
}

/** Runs `work` over the items, at most `limit` at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const item = items[next++] as T
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()))
}

const formKeyOf = (kind: BulkAskKind, form: AskForm): string => JSON.stringify({ kind, reason: form.reason.trim(), reasonCode: form.reasonCode })

export function useAskMany(setup: AskSetup): {
  readonly model: AskManyReviewModel | null
  readonly open: (kind: BulkAskKind, rows: readonly ProductionRow[]) => void
  readonly actions: AskManyReviewActions
  readonly busy: boolean
  /** The kinds Ask ▾ offers (undefined: not asked for yet; null: being read). */
  readonly kinds: readonly BulkAskKind[] | null | undefined
  /** Reads the kinds once, from the rules of one of the customer's orders. */
  readonly readKinds: (orderId: string) => void
} {
  const { api, locale, t, tOrders, day, money, facts, onChanged, onDone } = setup
  const [state, setState] = useState<AskState | null>(null)
  const [kinds, setKinds] = useState<readonly BulkAskKind[] | null | undefined>(undefined)
  const kindsAsked = useRef(false)
  const impactsControl = useRef<AbortController | null>(null)
  const rulesControl = useRef<AbortController | null>(null)
  const slot = useRef<{ body: string; key: string } | null>(null)
  const undoSlot = useRef<{ body: string; key: string } | null>(null)
  const keyIn = (ref: { current: { body: string; key: string } | null }, body: unknown): string => {
    const text = JSON.stringify(body)
    if (ref.current?.body !== text) ref.current = { body: text, key: newIdempotencyKey() }
    return ref.current.key
  }
  useEffect(
    () => () => {
      impactsControl.current?.abort()
      rulesControl.current?.abort()
    },
    [],
  )

  const readKinds = (orderId: string) => {
    if (kindsAsked.current) return
    kindsAsked.current = true
    setKinds(null)
    fetchRules(api, orderId)
      .then((rules) => setKinds(askKindsOf(rules)))
      // The limits could not be read: every kind is offered; each order's own rules say in the review what it allows.
      .catch(() => setKinds(ASK_MENU))
  }

  const open = (kind: BulkAskKind, picked: readonly ProductionRow[]) => {
    if (picked.length === 0) return
    rulesControl.current?.abort()
    impactsControl.current?.abort()
    const control = new AbortController()
    rulesControl.current = control
    slot.current = null
    undoSlot.current = null
    const rows = askRowNamesOf(picked, locale, t)
    const loading: Record<string, Read<ChangeRules>> = {}
    for (const row of rows) loading[row.id] = { state: 'loading', value: null }
    setState({ kind, rows, rules: loading, form: EMPTY_ASK_FORM, impacts: {}, impactKey: null, phase: 'ready', sent: null, results: null, counts: null, batchId: null, problem: null, undo: 'idle', undoLine: null })
    void eachLimited(rows, 4, async (row) => {
      let read: Read<ChangeRules>
      try {
        read = { state: 'ready', value: await fetchRules(api, row.id, control.signal) }
      } catch {
        read = { state: 'error', value: null }
      }
      if (control.signal.aborted) return
      setState((current) => (current && current.kind === kind ? { ...current, rules: { ...current.rules, [row.id]: read } } : current))
    })
  }

  // ── the review as it is now ─────────────────────────────────────────────────────────────────────────────────────────────
  const rulesRead = state ? state.rows.every((row) => state.rules[row.id]?.state !== 'loading') : false
  const reasons = state ? cancelReasonsOf(state.rows.map((row) => state.rules[row.id]?.value ?? null)) : []
  const formProblem = state ? askFormProblem(state.kind, state.form, reasons) : null
  const formKey = state ? formKeyOf(state.kind, state.form) : null
  const possibleIds = state && rulesRead ? state.rows.filter((row) => { const rules = state.rules[row.id]?.value; return rules ? askVerdictOf(state.kind, rules, locale, tOrders, day, t).possible : false }).map((row) => row.id) : []
  const possibleKey = possibleIds.join(',')

  // The impact of each order that may be asked, read once the fields are filled in (and again when they change, after a pause).
  useEffect(() => {
    if (!state || state.phase !== 'ready' || !rulesRead || formProblem || !formKey || formKey === state.impactKey || possibleIds.length === 0) return
    const timer = setTimeout(() => {
      impactsControl.current?.abort()
      const control = new AbortController()
      impactsControl.current = control
      const body = askBodyOf(state.kind, state.form)
      const loading: Record<string, Read<ImpactRead>> = {}
      for (const id of possibleIds) loading[id] = { state: 'loading', value: null }
      setState((current) => (current ? { ...current, impacts: loading, impactKey: formKey } : current))
      void eachLimited(possibleIds, 4, async (id) => {
        let read: Read<ImpactRead>
        try {
          read = { state: 'ready', value: await fetchImpact(api, id, body, control.signal) }
        } catch {
          read = { state: 'error', value: null }
        }
        if (control.signal.aborted) return
        setState((current) => (current && current.impactKey === formKey ? { ...current, impacts: { ...current.impacts, [id]: read } } : current))
      })
    }, 400)
    return () => clearTimeout(timer)
    // Read again only when what it reads changes: the phase, the form (its key), the rules read, the orders that may be asked
    // (`possibleKey` stands for `possibleIds`, a new array each render).
  }, [state?.phase, state?.impactKey, rulesRead, formProblem, formKey, possibleKey])

  const live: AskReview | null =
    state && state.phase === 'ready'
      ? askReviewOf(
          state.kind,
          state.rows.map((row) => ({ ...row, rules: { state: state.rules[row.id]?.state ?? 'loading', rules: state.rules[row.id]?.value ?? null }, impact: state.impactKey !== null && state.impactKey === formKey ? (state.impacts[row.id] ? { state: state.impacts[row.id]!.state, read: state.impacts[row.id]!.value } : null) : null })),
          { locale, t, tOrders, day, money },
        )
      : null
  const shown = state?.phase === 'ready' ? live : (state?.sent ?? null)
  const impactPending = !!state && rulesRead && !formProblem && possibleIds.length > 0 && state.impactKey !== formKey
  const commonFacts = { ...facts, busy: state?.phase === 'saving' }
  const held = live && state ? (impactPending ? t('bulk.ask.held.reading') : askHeldOf(live, formProblem ? formProblem : null, commonFacts, (key, params) => t(key, { max: BULK_REASON_MAX, ...(params ?? {}) }))) : null

  const save = () => {
    if (!state || state.phase !== 'ready' || !live || held) return
    const review = live
    const body = askManyBodyOf(state.kind, review.send, state.form)
    setState({ ...state, phase: 'saving', sent: review, problem: null })
    askMany(api, body, keyIn(slot, body))
      .then((answer) => {
        slot.current = null
        const outcome = askResultsOf(review, answer, locale, t)
        setState((current) => (current ? { ...current, phase: 'done', results: outcome.results, counts: { asked: outcome.asked, not: outcome.not }, batchId: answer.batchId } : current))
        onChanged()
      })
      .catch((error: unknown) => {
        const refused = askRefusalOf(review, error, t, tOrders)
        if (refused.results) {
          slot.current = null
          const results = refused.results
          setState((current) => (current ? { ...current, phase: 'done', results, counts: { asked: 0, not: review.send.length } } : current))
          onChanged()
        } else {
          setState((current) => (current ? { ...current, phase: 'ready', sent: null, problem: refused.problem } : current))
        }
      })
  }

  const undo = () => {
    if (!state || state.phase !== 'done' || !state.batchId || state.undo !== 'idle') return
    const batchId = state.batchId
    setState({ ...state, undo: 'busy' })
    withdrawAskBatch(api, batchId, keyIn(undoSlot, { withdraw: batchId }))
      .then((answer) => {
        undoSlot.current = null
        setState((current) => {
          if (!current || !current.results) return current
          const results: Record<string, RowResult> = {}
          for (const [id, result] of Object.entries(current.results)) results[id] = result.ok ? { ok: true, words: t('bulk.result.undone'), tone: 'neutral' } : result
          return { ...current, undo: 'done', undoLine: undoLineOf(null, answer, t), results }
        })
        onChanged()
      })
      .catch((error: unknown) => setState((current) => (current ? { ...current, undo: 'idle', undoLine: undoProblemOf(error, t) } : current)))
  }

  const close = () => {
    if (!state || state.phase === 'saving' || state.undo === 'busy') return
    rulesControl.current?.abort()
    impactsControl.current?.abort()
    const finished = state.phase === 'done'
    setState(null)
    if (finished) onDone()
  }

  const model: AskManyReviewModel | null =
    state && shown
      ? {
          kind: state.kind,
          title: askTitleOf(shown, t),
          lead: t(`bulk.ask.lead.${state.kind}`),
          rows: shown.rows,
          form: state.form,
          reasons: reasons.map((reason) => ({ code: reason.code, label: reason.words[locale], needsNote: reason.needsNote })),
          formProblem: state.phase === 'ready' && formProblem && (state.form.reason !== '' || state.form.reasonCode !== '') ? t(formProblem, { max: BULK_REASON_MAX }) : null,
          phase: state.phase,
          results: state.results,
          doneLine: state.counts ? (state.undoLine ? { line: state.undoLine, tone: state.undo === 'done' ? 'success' : 'warning' } : doneLineOf({ done: 0, asked: state.counts.asked, not: state.counts.not }, t)) : null,
          save: askSaveOf(shown, t),
          held: state.phase === 'ready' ? held : null,
          problem: state.phase === 'done' ? null : state.problem,
          undo: state.phase === 'done' && state.batchId && state.undo !== 'done' && (state.counts?.asked ?? 0) > 0 ? { busy: state.undo === 'busy' } : null,
        }
      : null

  return {
    model,
    open,
    busy: state?.phase === 'saving',
    kinds,
    readKinds,
    actions: {
      onReason: (text) => setState((current) => (current && current.phase === 'ready' ? { ...current, form: { ...current.form, reason: text } } : current)),
      onReasonCode: (code) => setState((current) => (current && current.phase === 'ready' ? { ...current, form: { ...current.form, reasonCode: code } } : current)),
      onSave: save,
      onUndo: undo,
      onClose: close,
    },
  }
}
