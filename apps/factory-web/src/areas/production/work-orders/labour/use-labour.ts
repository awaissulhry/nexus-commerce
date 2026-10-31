'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { getWorkOrderCost, type WorkOrderCost } from '../../../finance/costing/api'
import { costingCanOf, readProblem } from '../../../finance/costing/model'
import type { LabourModel } from './model'

/**
 * B-W2a-72 — the work order's Labour & cost tab reads its cost (`GET /costing/work-orders/:id`, costing.view) when the tab
 * is open, again when the work order changes (its version) and on Try again; nothing without costing.view or before the
 * release (a draft collects no cost) or without the cost grain (the whole section needs it). The record's container calls it and hands the model to the view.
 */
export function useLabourCost(api: ApiClient, workOrderId: string, open: boolean, permissions: readonly string[], workOrder: { status: string; version: number } | null): { model: LabourModel; retry: () => void } {
  const can = useMemo(() => costingCanOf(permissions), [permissions])
  const [part, setPart] = useState<{ value: WorkOrderCost | null; problem: string | null } | null>(null)
  const seq = useRef(0)
  const asks = open && can.view && can.cost && workOrder !== null && workOrder.status !== 'DRAFT'
  const read = useCallback(() => {
    const mine = ++seq.current
    setPart((current) => ({ value: current?.value ?? null, problem: null }))
    getWorkOrderCost(api, workOrderId)
      .then((value) => mine === seq.current && setPart({ value, problem: null }))
      .catch((error: unknown) => mine === seq.current && setPart({ value: null, problem: readProblem(error) }))
  }, [api, workOrderId])
  useEffect(() => {
    if (asks) read()
  }, [asks, read, workOrder?.version])
  return { model: { can, part: asks ? (part ?? { value: null, problem: null }) : null }, retry: read }
}
