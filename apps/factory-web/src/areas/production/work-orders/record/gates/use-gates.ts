'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import type { Milestones } from '../../../../planning/milestones/api'
import type { WorkOrder } from '../../../_shared/api'
import { readProblem } from '../../../_shared/model'
import { getOrderGates } from './api'

/** The gates part of the Overview: null without planning.view (no card); else the answers per order, a problem, Try again. */
export interface GatesPart {
  readonly value: readonly Milestones[] | null
  readonly problem: string | null
}

/** F-PR-05a — reads the gates of the work order's own orders (planning.view), once per work order and after each change of it. */
export function useOrderGates(api: ApiClient, workOrder: WorkOrder | null, permissions: readonly string[], enabled: boolean): { part: GatesPart | null; retry: () => void } {
  const can = permissions.includes('planning.view')
  const [part, setPart] = useState<GatesPart>({ value: null, problem: null })
  const turn = useRef(0)
  const orderIds = [...new Set((workOrder?.orders ?? []).map((order) => order.id))].join(',')
  const read = useCallback(() => {
    if (!can || !enabled) return
    const mine = ++turn.current
    const ids = orderIds ? orderIds.split(',') : []
    setPart({ value: null, problem: null })
    Promise.all(ids.map((id) => getOrderGates(api, id)))
      .then((value) => mine === turn.current && setPart({ value, problem: null }))
      .catch((error: unknown) => mine === turn.current && setPart({ value: null, problem: readProblem(error) }))
  }, [api, can, enabled, orderIds])
  useEffect(() => {
    read()
  }, [read, workOrder?.version])
  return { part: can ? part : null, retry: read }
}
