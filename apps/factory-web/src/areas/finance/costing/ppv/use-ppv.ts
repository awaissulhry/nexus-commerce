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

const SLOW_MS = 1000
const BUILT = new Set(OFFICE_PAGES)

/**
 * B-W2b-424 — the Purchase price variance section's reads for Finance › Costing (SCR-462): the period's variances of the
 * company (GET /costing/ppv?from&to), "Still loading…" after a second, Show more by cursor, read again on a variance
 * posted or taken back and on the company's switch (live, costing.view), the CSV of the chosen rows, and Enter on a row
 * opens the document it comes from (`go`: the page's router). Nothing without costing.view (the page says why).
 */
export function usePpv(api: ApiClient, view: boolean, cost: boolean, companyId: string | null, period: PpvSectionModel['period'], locale: Locale, prefix: string, go: (href: string) => void): { model: PpvSectionModel; actions: PpvSectionActions } {
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
  const actions: PpvSectionActions = {
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
  return { model: { cost, period, rows: state.rows, more: state.more, problem: state.problem, slow: state.slow, totals: state.totals, waits: state.waits }, actions }
}
