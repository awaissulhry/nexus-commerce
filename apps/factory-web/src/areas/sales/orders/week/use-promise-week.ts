'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import type { OfficeSession } from '../../../../lib/session/session'
import { listPromiseLines } from '../depth/api'
import { depthCanOf, readProblemOf } from '../depth/model'
import { siteOf, weekColumns, type WeekColumn } from './model'

export type WeekState =
  | { status: 'loading' }
  | { status: 'ready'; columns: WeekColumn[]; complete: boolean; asOf: string; today: string }
  | { status: 'error'; problem: string }
  | { status: 'forbidden' }
  | { status: 'noSite' }

export interface WeekModel {
  state: WeekState
  sites: ReadonlyArray<{ id: string; code: string; name: string }>
  siteId: string | null
}

/**
 * By promise week's container (B-W2b-323): the open lines of one site of the person's (B-W2b-317's GET /planning/promises, the
 * read sales holds: planning.promise.view; the address's `?site=`, else the first by code), the search of the list as its `q`,
 * read again on the list's live changes. Never re-ranks: the backlog's own place rides on each line.
 */
export function usePromiseWeek(api: ApiClient, session: OfficeSession, input: { enabled: boolean; asked: string | null; q: string; tick: number }): WeekModel & { retry: () => void } {
  const can = useMemo(() => depthCanOf(session.permissions), [session.permissions])
  const sites = useMemo(() => [...session.sites].sort((a, b) => (a.code ?? '').localeCompare(b.code ?? '')).map((site) => ({ id: site.id, code: site.code ?? '', name: site.name })), [session.sites])
  const siteId = siteOf(sites, input.asked)
  const [state, setState] = useState<WeekState>({ status: 'loading' })
  const [again, setAgain] = useState(0)
  useEffect(() => {
    if (!input.enabled) return
    if (!can.promise) {
      setState({ status: 'forbidden' })
      return
    }
    if (!siteId) {
      setState({ status: 'noSite' })
      return
    }
    const abort = new AbortController()
    setState((known) => (known.status === 'ready' ? known : { status: 'loading' }))
    listPromiseLines(api, siteId, { q: input.q, limit: 300 }, abort.signal)
      .then((answer) => !abort.signal.aborted && setState({ status: 'ready', columns: weekColumns(answer.lines, answer.today), complete: answer.complete, asOf: answer.asOf, today: answer.today }))
      .catch((error: unknown) => {
        if (abort.signal.aborted) return
        const problem = readProblemOf(error)
        setState(problem === 'problem.read.forbidden' ? { status: 'forbidden' } : { status: 'error', problem })
      })
    return () => abort.abort()
  }, [api, can.promise, siteId, input.enabled, input.q, input.tick, again])
  const retry = useCallback(() => setAgain((value) => value + 1), [])
  return { state, sites, siteId, retry }
}
