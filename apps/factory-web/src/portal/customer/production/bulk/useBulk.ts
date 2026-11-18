'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { DEFAULT_TIME_ZONE } from '../../../../lib/i18n/format'
import type { Locale } from '../../../../lib/i18n/locales'
import { saveBytes } from '../../orders/hooks'
import { downloadProduction, markUrgency, saveUrgentOrder, undoUrgency, type ProductionList, type UndoAnswer, type UrgencyAnswer } from '../api'
import type { Notice } from '../model'
import type { ProblemOrder } from '../problem/model'
import type { BulkReviewActions, BulkReviewModel } from '../view/BulkReview'
import { downloadFilesZip, withdrawAskBatch, type WithdrawAnswer } from './api'
import {
  allIdsOf,
  bulkBarOf,
  doneLineOf,
  keepPicked,
  markReviewOf,
  outcomeOf,
  pickedRowsOf,
  problemOrdersOfRows,
  refusedOutcomeOf,
  reviewAsks,
  reviewHeldOf,
  reviewLeadOf,
  reviewSaveOf,
  reviewTitleOf,
  topReviewOf,
  undoLineOf,
  undoProblemOf,
  zipNameOf,
  zipProblemOf,
  type BulkActionId,
  type BulkBar,
  type BulkFacts,
  type BulkOutcome,
  type Review,
  type ReviewKind,
  type RowResult,
} from './model'

/**
 * F-PR-23a — the bulk bar's container on My production, ONE place for the picked rows and what they do: the selection (kept while
 * the list is read again, only rows still in it), the bar, the review before Send of Mark urgent · Mark regular · Move to top (one
 * command with one Idempotency-Key kept while the same thing is sent again: a retry after a lost answer is the same request), the
 * result per row, Undo (the urgency batch put back; what a Mark urgent asked of us withdrawn), and More ▾: Report a problem (THE
 * F-PR-24 dialog with the orders named), Download files (one zip), Export (the server's file of the picked rows). At most 50.
 */

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

export interface BulkSetup {
  readonly api: ApiClient
  readonly read: ProductionList | null
  readonly locale: Locale
  readonly t: Translate
  readonly facts: Omit<BulkFacts, 'busy'>
  /** The list is read again (after a send, an Undo, a refusal that moved it). */
  readonly onChanged: () => void
  /** A notice under the band (a file made or not). */
  readonly onNotice: (notice: Notice) => void
  /** Opens THE Report a problem dialog (F-PR-24) with these orders named. */
  readonly onReport: (orders: ProblemOrder[]) => void
}

interface ReviewState {
  readonly kind: ReviewKind
  /** The ids picked when the review opened. */
  readonly ids: readonly string[]
  readonly needBy: string
  readonly phase: 'ready' | 'saving' | 'done'
  /** The review as sent: the rows do not move under their results while the list is read again. */
  readonly sent: Review | null
  readonly outcome: BulkOutcome | null
  readonly problem: string | null
  readonly undo: 'idle' | 'busy' | 'done'
  /** After an Undo: what it did, or why it did not (the Done line). */
  readonly undoLine: string | null
}

/** Today in the site's zone (`YYYY-MM-DD`): the earliest need-by date, and the zip's day. */
const todayInZone = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

/** One key per thing sent on one channel: the same body again (a retry) is the same request; anything else a new one. */
function useKeySlot(): { readonly keyFor: (body: unknown) => string; readonly reset: () => void } {
  const slot = useRef<{ body: string; key: string } | null>(null)
  return useMemo(
    () => ({
      keyFor: (body: unknown) => {
        const text = JSON.stringify(body)
        if (slot.current?.body !== text) slot.current = { body: text, key: newIdempotencyKey() }
        return slot.current.key
      },
      reset: () => {
        slot.current = null
      },
    }),
    [],
  )
}

export interface BulkActions {
  readonly onSelect: (ids: string[]) => void
  readonly onSelectAll: () => void
  readonly onAction: (id: BulkActionId) => void
  readonly review: BulkReviewActions
}

export function useBulk(setup: BulkSetup): { readonly selected: readonly string[]; readonly bar: BulkBar | null; readonly review: BulkReviewModel | null; readonly actions: BulkActions } {
  const { api, read, locale, t, facts, onChanged, onNotice, onReport } = setup
  const rows = useMemo(() => read?.items ?? [], [read])
  const [selected, setSelected] = useState<string[]>([])
  const [state, setState] = useState<ReviewState | null>(null)
  const [filing, setFiling] = useState(false)
  const [exporting, setExporting] = useState(false)
  const send = useKeySlot()
  const undoKey = useKeySlot()
  const withdrawKey = useKeySlot()

  // A row that left the list (another chip, a search, it left production) is no longer picked.
  useEffect(() => {
    setSelected((current) => {
      const kept = keepPicked(current, rows)
      return kept.length === current.length ? current : kept
    })
  }, [rows])

  const picked = useMemo(() => pickedRowsOf(rows, selected), [rows, selected])
  const busy = state?.phase === 'saving' || filing || exporting
  const allFacts: BulkFacts = { ...facts, busy }

  // ── the review: computed from the list as it is while it waits for Send; as sent afterwards ─────────────────────────────
  const live = useMemo((): Review | null => {
    if (!state || state.phase !== 'ready') return null
    const inReview = pickedRowsOf(rows, state.ids)
    return state.kind === 'TOP' ? topReviewOf(inReview, rows, locale, t) : markReviewOf(inReview, state.kind, read?.urgentUse ?? null, facts, locale, t)
  }, [state, rows, read, facts, locale, t])
  const shown = state?.phase === 'ready' ? live : (state?.sent ?? null)

  const openReview = (kind: ReviewKind) => {
    if (picked.length === 0) return
    send.reset()
    setState({ kind, ids: picked.map((row) => row.id), needBy: '', phase: 'ready', sent: null, outcome: null, problem: null, undo: 'idle', undoLine: null })
  }

  const save = async () => {
    if (!state || state.phase !== 'ready' || !live || !read) return
    if (reviewHeldOf(live, allFacts, t)) return
    const review = live
    setState({ ...state, phase: 'saving', sent: review, problem: null })
    try {
      let answer: UrgencyAnswer
      if (review.kind === 'TOP') {
        const body = { orderIds: review.order ?? [], asOf: read.asOf }
        answer = await saveUrgentOrder(api, body, send.keyFor(body))
      } else {
        const body = { orderIds: [...review.send], urgency: review.kind, ...(reviewAsks(review) && state.needBy ? { requestedDate: state.needBy } : {}) }
        answer = await markUrgency(api, body, send.keyFor(body))
      }
      send.reset()
      const outcome = outcomeOf(review, answer, locale, t)
      setState((current) => (current ? { ...current, phase: 'done', outcome } : current))
      onChanged()
    } catch (error) {
      const refused = refusedOutcomeOf(review, error, t)
      if (refused.outcome) {
        send.reset()
        const outcome = refused.outcome
        setState((current) => (current ? { ...current, phase: 'done', outcome } : current))
        onChanged()
      } else {
        // Not sent (or no answer): the review stays; Send tries again with the same key (nothing is done twice).
        setState((current) => (current ? { ...current, phase: 'ready', sent: null, problem: refused.problem } : current))
      }
    }
  }

  const undo = async () => {
    const targets = state?.outcome?.undo
    if (!state || state.phase !== 'done' || !targets || state.undo !== 'idle') return
    setState({ ...state, undo: 'busy' })
    let urgency: UndoAnswer | null = null
    let asks: WithdrawAnswer | null = null
    let problem: string | null = null
    if (targets.batchId) {
      const body = { undo: targets.batchId }
      try {
        urgency = await undoUrgency(api, targets.batchId, undoKey.keyFor(body))
      } catch (error) {
        problem = undoProblemOf(error, t)
      }
    }
    if (targets.askBatchId) {
      const body = { withdraw: targets.askBatchId }
      try {
        asks = await withdrawAskBatch(api, targets.askBatchId, withdrawKey.keyFor(body))
      } catch (error) {
        problem = problem ?? undoProblemOf(error, t)
      }
    }
    const any = urgency !== null || asks !== null
    if (any) {
      undoKey.reset()
      withdrawKey.reset()
    }
    setState((current) => {
      if (!current || !current.outcome) return current
      // Nothing put back: Undo stays offered, with why.
      if (!any) return { ...current, undo: 'idle', undoLine: problem }
      const results: Record<string, RowResult> = {}
      for (const [id, result] of Object.entries(current.outcome.results)) results[id] = result.ok ? { ok: true, words: t('bulk.result.undone'), tone: 'neutral' } : result
      const line = [undoLineOf(urgency, asks, t), problem].filter((part): part is string => !!part).join(' ')
      return { ...current, undo: 'done', undoLine: line, outcome: { ...current.outcome, results, undo: null } }
    })
    if (any) onChanged()
  }

  const close = () => {
    if (!state || state.phase === 'saving' || state.undo === 'busy') return
    const finished = state.phase === 'done'
    setState(null)
    // Done: the picked orders were acted on; the bar starts again from nothing.
    if (finished) setSelected([])
  }

  // ── More ▾ ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
  const files = async () => {
    if (filing || picked.length === 0) return
    setFiling(true)
    try {
      const bytes = await downloadFilesZip(api, picked.map((row) => row.id))
      saveBytes(zipNameOf(todayInZone(), t), bytes, 'application/zip')
      onNotice({ tone: 'success', words: t('bulk.filesDone', { count: picked.length }) })
    } catch (error) {
      onNotice({ tone: 'warning', words: zipProblemOf(error, t) })
    } finally {
      setFiling(false)
    }
  }

  const exportPicked = async () => {
    if (exporting || picked.length === 0) return
    setExporting(true)
    try {
      const file = await downloadProduction(api, { chip: null, q: null, locale: locale === 'it' ? 'it' : 'en', orderIds: picked.map((row) => row.id) })
      saveBytes(file.fileName ?? `${t('list.fileName')}.csv`, file.bytes, file.contentType)
    } catch {
      onNotice({ tone: 'warning', words: t('notice.exportFailed') })
    } finally {
      setExporting(false)
    }
  }

  const onAction = (id: BulkActionId) => {
    const bar = bulkBarOf(picked, rows.length, allFacts, t)
    const action = [...bar.actions, ...bar.more].find((entry) => entry.id === id)
    if (!action || action.held) return
    switch (id) {
      case 'URGENT':
      case 'REGULAR':
      case 'TOP':
        openReview(id)
        return
      case 'REPORT':
        onReport(problemOrdersOfRows(picked, locale, t))
        return
      case 'FILES':
        void files()
        return
      case 'EXPORT':
        void exportPicked()
        return
      case 'APPROVE':
        return
    }
  }

  const onSelect = useCallback((ids: string[]) => setSelected(ids), [])

  const outcome = state?.outcome ?? null
  const review: BulkReviewModel | null =
    state && shown
      ? {
          title: reviewTitleOf(shown, t),
          lead: reviewLeadOf(shown, read?.urgentUse ?? null, t),
          rows: shown.rows,
          needBy: shown.kind === 'URGENT' && reviewAsks(shown) ? { value: state.needBy, min: todayInZone() } : null,
          phase: state.phase,
          results: outcome?.results ?? null,
          doneLine: outcome ? (state.undoLine ? { line: state.undoLine, tone: state.undo === 'done' ? 'success' : 'warning' } : doneLineOf(outcome, t)) : null,
          save: reviewSaveOf(shown, t),
          held: state.phase === 'ready' ? reviewHeldOf(shown, allFacts, t) : null,
          problem: state.phase === 'done' ? null : state.problem,
          undo: state.phase === 'done' && outcome?.undo && state.undo !== 'done' ? { busy: state.undo === 'busy' } : null,
        }
      : null

  return {
    selected,
    bar: picked.length > 0 ? bulkBarOf(picked, rows.length, allFacts, t) : null,
    review,
    actions: {
      onSelect,
      onSelectAll: () => setSelected(allIdsOf(rows)),
      onAction,
      review: {
        onNeedBy: (day) => setState((current) => (current && current.phase === 'ready' ? { ...current, needBy: day } : current)),
        onSave: () => void save(),
        onUndo: () => void undo(),
        onClose: close,
      },
    },
  }
}
