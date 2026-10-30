'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { pickerReasons, type PickerReason } from '../../../_shared/reasons/api'
import { readProblem, stockCan, TIME_ZONE } from '../../../_shared/stock/model'
import { readTrace, type Trace } from '../../stock/daily/api'
import { dailyCan } from '../shared/daily'
import { LOADING, ready, type Loaded } from '../shared/model'
import { LotsMessages } from '../shared/parts'
import { traceAddressOf } from './model'
import { useTraceFind } from './useTraceFind'
import { TracePageView } from './view/TracePageView'

/**
 * `/w/<company>/warehouse/lots/trace?kind=&id=&direction=` (SCR-201-trace): reads the trace of the record the address
 * names (`GET /inventory/trace`, computed now, nothing stored) and the HOLD reasons' words (quality.holds.view); the
 * direction in the address; Trace another code… opens the Trace dialog.
 */
export function TracePage() {
  return (
    <LotsMessages>
      <TraceContainer />
    </LotsMessages>
  )
}

function TraceContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => stockCan(session.permissions), [session.permissions])
  const daily = useMemo(() => dailyCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const start = useMemo(() => traceAddressOf(params), [params])
  const [trace, setTrace] = useState<Loaded<Trace>>(LOADING)
  const [holdReasons, setHoldReasons] = useState<PickerReason[]>([])
  const find = useTraceFind(api, prefix)

  const load = useCallback(async () => {
    if (!can.stockView || !start) return
    setTrace(LOADING)
    try {
      setTrace(ready(await readTrace(api, { kind: start.kind, id: start.id }, start.direction)))
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setTrace({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setTrace({ status: 'forbidden' })
      else setTrace({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.stockView, start])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!daily.holdsView) return
    pickerReasons(api, ['HOLD'])
      .then(setHoldReasons)
      .catch(() => setHoldReasons([]))
  }, [api, daily.holdsView])

  return (
    <TracePageView
      model={{ prefix, can, start, trace, holdReasons, asOf: trace.status === 'ready' ? trace.value.asOf : null, timeZone: TIME_ZONE, find: find.model }}
      actions={{
        onRetry: () => void load(),
        onDirection: (direction) => {
          if (!start) return
          const query = new URLSearchParams({ kind: start.kind, id: start.id })
          if (direction !== 'BOTH') query.set('direction', direction)
          router.replace(`${pathname}?${query.toString()}`)
        },
        onTraceAnother: find.open,
        find: find.actions,
      }}
    />
  )
}
