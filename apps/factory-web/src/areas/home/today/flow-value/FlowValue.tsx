'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useLiveBus } from '../../../../shell/live/use-live'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { getFlowValue, type FlowValue as FlowValueAnswer } from './api'
import { flowValueShown } from './model'
import { FlowValueView, type FlowValueModel } from './view/FlowValueView'

/** The work-order events after which the value may have moved (read again at most once a minute). */
const MOVES = new Set(['workorder.created', 'workorder.released', 'workorder.status_changed', 'work_order_cost.posted', 'work_order_cost.reversed'])
const QUIET_MS = 60_000

/**
 * Today's value per stage, the container (B-W2b-435): reads GET /home/flow/value (the top bar's site) for a person with the cost
 * grain and costing.view — never asked otherwise — and draws it only under the work-order flow (`lens`). Today mounts it right
 * after its flow strip, in its section list.
 */
export function FlowValue({ lens }: { readonly lens: string | null }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const asks = session.permissions.includes('costing.view') && session.permissions.includes('workorders.view')
  const [read, setRead] = useState<FlowValueModel['read']>({ status: 'loading' })
  const [answer, setAnswer] = useState<FlowValueAnswer | null>(null)
  const last = useRef(0)

  const load = useCallback(async () => {
    if (!asks) return
    last.current = Date.now()
    try {
      const value = await getFlowValue(api, { siteId: scope.siteId })
      setAnswer(value)
      setRead({ status: 'ready', data: value })
    } catch {
      setRead({ status: 'error', problem: 'flowValue.error' })
    }
  }, [api, asks, scope.siteId])
  useEffect(() => {
    void load()
  }, [load])
  useLiveBus({ onChange: (change) => MOVES.has(change.type) && Date.now() - last.current > QUIET_MS && void load(), onReconnect: () => void load() }, asks)

  if (!asks || lens !== 'WORK_ORDERS') return null
  if (read.status === 'ready' && !flowValueShown(lens, answer)) return null
  return <FlowValueView model={{ read }} onRetry={() => void load()} />
}
