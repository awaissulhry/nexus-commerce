'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import type { Locale } from '../../../../lib/i18n/locales'
import { recordAddress } from '../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../shell/nav/office-nav'
import { downloadText, useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem } from '../../../production/work-orders/close/model'
import { getPpv, type PpvAnswer, type PpvRow } from './api'
import { documentRef, ppvCsv, ppvTouches, type PpvSectionActions, type PpvSectionModel } from './model'
// B-W2b-GB02 (G053): a variance reversed with its reason, a document's variances posted by hand.
import { newIdempotencyKey } from '../../../../lib/api/client'
import { findDocuments, postPpv, reversePpv, type PpvDocument } from './api'
import { documentByNumber, postResultOf, ppvFindProblem, ppvWriteProblem, type PpvDialog, type PpvPhrase } from './model'

const SLOW_MS = 1000
const BUILT = new Set(OFFICE_PAGES)

/**
 * B-W2b-424 — the Purchase price variance section's reads for Finance › Costing (SCR-462): the period's variances of the
 * company (GET /costing/ppv?from&to), "Still loading…" after a second, Show more by cursor, read again on a variance
 * posted or taken back and on the company's switch (live, costing.view), the CSV of the chosen rows, and Enter on a row
 * opens the document it comes from (`go`: the page's router). Nothing without costing.view (the page says why).
 */
export function usePpv(api: ApiClient, view: boolean, cost: boolean, companyId: string | null, period: PpvSectionModel['period'], locale: Locale, prefix: string, go: (href: string) => void, manage = false): { model: PpvSectionModel; actions: PpvSectionActions } {
  const [state, setState] = useState<{ rows: readonly PpvRow[] | null; more: boolean; problem: string | null; slow: boolean; cursor: string | null; totals: PpvAnswer['totals'] | null; waits: boolean }>({ rows: null, more: false, problem: null, slow: false, cursor: null, totals: null, waits: false })
  const turn = useRef(0)
  const read = useCallback(async () => {
    if (!view) return
    const mine = ++turn.current
    const slow = setTimeout(() => mine === turn.current && setState((now) => (now.rows || now.problem ? now : { ...now, slow: true })), SLOW_MS)
    try {
      const page = await getPpv(api, { companyId, from: period.from, to: period.to })
      if (mine === turn.current) setState({ rows: page.rows, more: page.nextCursor !== null, problem: null, slow: false, cursor: page.nextCursor, totals: page.totals, waits: page.waits !== null })
    } catch (error) {
      if (mine === turn.current) setState((now) => ({ ...now, rows: null, problem: readProblem(error), slow: false }))
    } finally {
      clearTimeout(slow)
    }
  }, [api, view, companyId, period.from, period.to])
  useEffect(() => {
    setState({ rows: null, more: false, problem: null, slow: false, cursor: null, totals: null, waits: false })
    void read()
  }, [read])
  const reread = useCoalesced(() => void read(), 900)
  useLive(
    (change) => {
      if (ppvTouches(change)) reread()
    },
    () => void read(),
    view,
  )
  // ---- B-W2b-GB02 (G053; B-W2b-424's gap 1): the writes, one Idempotency-Key per attempt; a refusal is said in the dialog.
  const [dialog, setDialog] = useState<PpvDialog | null>(null)
  const [notice, setNotice] = useState<PpvSectionModel['notice']>(null)
  const attempt = useRef<string | null>(null)
  const submitReverse = (reason: string) => {
    if (dialog?.kind !== 'reverse' || dialog.busy) return
    const row = dialog.row
    attempt.current ??= newIdempotencyKey()
    setDialog({ ...dialog, busy: true, problem: null })
    reversePpv(api, row.id, reason, attempt.current)
      .then(() => {
        attempt.current = null
        setDialog(null)
        setNotice({ tone: 'success', words: { key: 'ppv.notice.reversed', params: { material: row.item.code, document: row.source.number } } })
        void read()
      })
      .catch((error: unknown) => {
        attempt.current = null
        setDialog({ kind: 'reverse', row, busy: false, problem: ppvWriteProblem(error) })
      })
  }
  const submitPost = (document: { at: 'RECEIPT' | 'INVOICE'; number: string }) => {
    if (dialog?.kind !== 'post' || dialog.busy) return
    const number = document.number.trim()
    const fail = (problem: PpvPhrase) => setDialog({ kind: 'post', busy: false, problem, result: null })
    setDialog({ kind: 'post', busy: true, problem: null, result: null })
    void (async () => {
      let found: PpvDocument[]
      try {
        found = await findDocuments(api, document.at, number, companyId)
      } catch (error) {
        fail(ppvFindProblem(error, document.at))
        return
      }
      const match = documentByNumber(found, number)
      if (!match) {
        fail({ key: document.at === 'RECEIPT' ? 'ppv.post.noReceipt' : 'ppv.post.noInvoice', params: { number } })
        return
      }
      attempt.current ??= newIdempotencyKey()
      try {
        const answer = await postPpv(api, { at: document.at, id: match.id }, attempt.current)
        attempt.current = null
        setDialog({ kind: 'post', busy: false, problem: null, result: postResultOf(match.number, answer) })
        void read()
      } catch (error) {
        attempt.current = null
        fail(ppvWriteProblem(error))
      }
    })()
  }
  // ---- end B-W2b-GB02
  const actions: PpvSectionActions = {
    // B-W2b-GB02 (G053)
    onReverse: (row) => {
      attempt.current = null
      setDialog(row ? { kind: 'reverse', row, busy: false, problem: null } : null)
    },
    onReverseSubmit: submitReverse,
    onPost: (open) => {
      attempt.current = null
      setDialog(open ? { kind: 'post', busy: false, problem: null, result: null } : null)
    },
    onPostSubmit: submitPost,
    onDismissNotice: () => setNotice(null),
    onRetry: () => void read(),
    onMore: () => {
      if (!state.cursor) return
      getPpv(api, { companyId, from: period.from, to: period.to, cursor: state.cursor })
        .then((page) => setState((now) => ({ ...now, rows: [...(now.rows ?? []), ...page.rows.filter((row) => !now.rows?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, cursor: page.nextCursor })))
        .catch((error: unknown) => setState((now) => ({ ...now, problem: readProblem(error) })))
    },
    onExport: (rows, words, fileName) => downloadText(fileName, ppvCsv(rows, cost, words, locale)),
    onOpen: (row) => go(`${prefix}${recordAddress(documentRef(row), BUILT)}`),
  }
  return { model: { cost, period, rows: state.rows, more: state.more, problem: state.problem, slow: state.slow, totals: state.totals, waits: state.waits, can: { manage }, dialog, notice }, actions }
}
