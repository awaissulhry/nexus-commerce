'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { ApiClient } from '../../../../lib/api/client'
import { readProblem } from '../../../_shared/stock/model'
import { findTrace, type TraceFind } from '../../stock/daily/api'
import { blankFind, findOutcome, traceHref, type TraceFindModel } from './model'
import type { TraceFindActions } from './TraceDialog'

/**
 * The Trace dialog's container part (the Lots band, the lot record band): asks `GET /inventory/trace/find?code=` for the
 * code scanned or typed, opens the one record found (its trace), or shows the several to pick from, or says none.
 */
export function useTraceFind(api: ApiClient, prefix: string) {
  const router = useRouter()
  const [model, setModel] = useState<TraceFindModel | null>(null)
  const latest = useRef(model)
  latest.current = model
  const asked = useRef(0)

  const go = useCallback(
    (match: TraceFind['matches'][number]) => {
      setModel(null)
      router.push(traceHref(prefix, match))
    },
    [prefix, router],
  )

  const actions: TraceFindActions = {
    onCode: (code) => setModel((current) => (current ? { ...current, code, state: current.state === 'finding' ? 'finding' : 'idle', matches: [], problem: null } : current)),
    onClose: () => setModel(null),
    onPick: go,
    onFind: () => {
      const current = latest.current
      if (!current || current.state === 'finding' || !current.code.trim()) return
      const id = ++asked.current
      setModel({ ...current, state: 'finding', matches: [], problem: null })
      findTrace(api, current.code)
        .then((answer) => {
          if (id !== asked.current) return
          const outcome = findOutcome(answer)
          if (outcome.open) go(outcome.open)
          else setModel((now) => (now ? { ...now, state: outcome.state, matches: answer.matches } : now))
        })
        .catch((error: unknown) => id === asked.current && setModel((now) => (now ? { ...now, state: 'error', problem: readProblem(error) } : now)))
    },
  }
  return { model, open: () => setModel(blankFind()), actions }
}
