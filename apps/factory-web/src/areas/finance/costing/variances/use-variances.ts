'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import type { Locale } from '../../../../lib/i18n/locales'
import { downloadText, useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem } from '../../../production/work-orders/close/model'
import { labourHref } from '../model'
import { getVariances, type VarianceRow, type Variances } from './api'
import { variancesCsv, variancesTouches, type VariancesSectionActions, type VariancesSectionModel } from './model'

const SLOW_MS = 1000

/**
 * B-W2b-GB02 (G053; B-W2b-424's gap 5) — the Variances by work order section's reads for Finance › Costing: the period's
 * variance lines of the closes that stand (GET /costing/variances?from&to&live), "Still loading…" after a second, Show more
 * by cursor, read again on a close, an undo or a reopen and on the company's switch (live, costing.view), the CSV of the
 * chosen lines, and Enter on a line opens its work order's Labour & cost tab (`go`: the page's router).
 */
export function useVariances(api: ApiClient, view: boolean, cost: boolean, companyId: string | null, period: VariancesSectionModel['period'], locale: Locale, prefix: string, go: (href: string) => void): { model: VariancesSectionModel; actions: VariancesSectionActions } {
  const [state, setState] = useState<{ rows: readonly VarianceRow[] | null; more: boolean; problem: string | null; slow: boolean; cursor: string | null; totals: Variances['totals'] | null; waits: boolean }>({ rows: null, more: false, problem: null, slow: false, cursor: null, totals: null, waits: false })
  const turn = useRef(0)
  const read = useCallback(async () => {
    if (!view) return
    const mine = ++turn.current
    const slow = setTimeout(() => mine === turn.current && setState((now) => (now.rows || now.problem ? now : { ...now, slow: true })), SLOW_MS)
    try {
      const page = await getVariances(api, { companyId, from: period.from, to: period.to })
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
      if (variancesTouches(change)) reread()
    },
    () => void read(),
    view,
  )
  const actions: VariancesSectionActions = {
    onRetry: () => void read(),
    onMore: () => {
      if (!state.cursor) return
      getVariances(api, { companyId, from: period.from, to: period.to, cursor: state.cursor })
        .then((page) => setState((now) => ({ ...now, rows: [...(now.rows ?? []), ...page.rows.filter((row) => !now.rows?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, cursor: page.nextCursor })))
        .catch((error: unknown) => setState((now) => ({ ...now, problem: readProblem(error) })))
    },
    onExport: (rows, words, fileName) => downloadText(fileName, variancesCsv(rows, cost, words, locale)),
    onOpen: (row) => go(labourHref(prefix, row.workOrder.id)),
  }
  return { model: { cost, period, rows: state.rows, more: state.more, problem: state.problem, slow: state.slow, totals: state.totals, waits: state.waits }, actions }
}
