'use client'

import { useCallback, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { readProblem } from '../../../_shared/stock/model'
import { openWorkOrders, reserve } from './api'
import type { ReserveActions, ReserveDialogModel, ReserveHide } from './dialog-model'
import { reserveHeldKey, reserveProblem } from './model'

/**
 * The Reserve to a work order dialog's container part (Hides' selection row): opens on the hides chosen (each already
 * said free or left out, with why), finds the site's open work orders (`GET /production/work-orders?open=true&siteId&q`,
 * workorders.view), and reserves the free hides whole for the one picked (`POST /inventory/reservations`, ONE
 * Idempotency-Key per dialog; all or nothing). `onDone` runs once they are reserved (the page reads again).
 */
export function useReserve(api: ApiClient, can: { workOrders: boolean; timeZone: string }, onDone: () => void) {
  const [model, setModel] = useState<ReserveDialogModel | null>(null)
  const key = useRef<string | null>(null)
  const latest = useRef(model)
  latest.current = model
  const asked = useRef(0)

  const find = useCallback(
    (siteId: string, query: string) => {
      if (!can.workOrders) return
      const id = ++asked.current
      setModel((current) => (current ? { ...current, query, workOrders: { value: null, problem: null } } : current))
      openWorkOrders(api, { siteId, q: query })
        .then((answer) => id === asked.current && setModel((current) => (current ? { ...current, workOrders: { value: answer.workOrders, problem: null } } : current)))
        .catch((error: unknown) => id === asked.current && setModel((current) => (current ? { ...current, workOrders: { value: null, problem: readProblem(error) } } : current)))
    },
    [api, can.workOrders],
  )

  const open = useCallback(
    (siteId: string, hides: ReserveHide[]) => {
      key.current = newIdempotencyKey()
      setModel({ siteId, hides, canSeeWorkOrders: can.workOrders, query: '', workOrders: { value: null, problem: null }, workOrderId: null, note: '', posting: false, problem: null, done: null, timeZone: can.timeZone })
      find(siteId, '')
    },
    [can.workOrders, can.timeZone, find],
  )

  const actions: ReserveActions = {
    onQuery: (query) => {
      const current = latest.current
      if (current) find(current.siteId, query)
    },
    onRetryWorkOrders: () => {
      const current = latest.current
      if (current) find(current.siteId, current.query)
    },
    onPick: (workOrderId) => setModel((current) => (current ? { ...current, workOrderId, problem: null } : current)),
    onNote: (note) => setModel((current) => (current ? { ...current, note } : current)),
    onClose: () => setModel(null),
    onReserve: () => {
      const current = latest.current
      if (!current || current.done || !key.current || reserveHeldKey(current)) return
      const free = current.hides.filter((hide) => hide.why === null)
      const workOrder = current.workOrders.value?.find((order) => order.id === current.workOrderId)
      setModel({ ...current, posting: true, problem: null })
      reserve(api, { siteId: current.siteId, workOrderId: current.workOrderId!, note: current.note, lines: free.map((hide) => ({ hideId: hide.id })) }, key.current)
        .then((answer) => {
          setModel((now) => (now ? { ...now, posting: false, done: { count: answer.reservations.length, workOrder: workOrder?.number ?? '' } } : now))
          onDone()
        })
        .catch((error: unknown) => setModel((now) => (now ? { ...now, posting: false, problem: reserveProblem(error) } : now)))
    },
  }
  return { model, open, actions }
}
