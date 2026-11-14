'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import type { CloseModel } from '../../close/use-close'
import { readProblem } from '../../close/model'
import { getWorkOrderCloses } from './api'
import type { VarianceModel } from './model'

/**
 * B-W2b-424 — the variance at close for the Labour & cost tab: reads the work order's closes (GET /costing/work-orders/:id/close)
 * while the tab is open, for a completed or closed work order, with costing.view and the cost grain (the whole cost section
 * needs both), again on the work order's version (a close, an undo and a reopen move it) and on Try again. A completed
 * work order's preview is the close check's split (the record's close hook reads it already).
 */
export function useVarianceAtClose(api: ApiClient, workOrderId: string, open: boolean, permissions: readonly string[], workOrder: { status: string; version: number } | null, close: CloseModel | null): { model: VarianceModel | null; retry: () => void } {
  const can = useMemo(() => ({ view: permissions.includes('costing.view'), cost: permissions.includes('money.cost') }), [permissions])
  const [closes, setCloses] = useState<VarianceModel['closes']>(null)
  const turn = useRef(0)
  const status = workOrder?.status ?? ''
  const asks = open && can.view && can.cost && (status === 'COMPLETED' || status === 'CLOSED')
  const read = useCallback(() => {
    const mine = ++turn.current
    setCloses((now) => ({ value: now?.value ?? null, problem: null }))
    getWorkOrderCloses(api, workOrderId)
      .then((value) => mine === turn.current && setCloses({ value, problem: null }))
      .catch((error: unknown) => mine === turn.current && setCloses({ value: null, problem: readProblem(error) }))
  }, [api, workOrderId])
  useEffect(() => {
    if (asks) read()
  }, [asks, read, workOrder?.version])
  const retry = useCallback(() => {
    if (asks) read()
  }, [asks, read])
  if (!open || !workOrder) return { model: null, retry }
  const check = close?.check ?? null
  const preview = status === 'COMPLETED' && check ? { split: check.value?.split ?? null, settles: check.value?.settles ?? false, problem: check.problem } : null
  return { model: { can, status, preview, closes: asks ? (closes ?? { value: null, problem: null }) : null }, retry }
}
