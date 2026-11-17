'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import type { WorkOrder } from '../../../_shared/api'
import { readProblem, type Phrase } from '../../../_shared/model'
import { clearBrandHealth, getBrandHealth, raiseBrandHealth } from './api'
import { healthOrdersOf, raiseProblem, type HealthActions, type HealthModel, type HealthPart } from './model'

/**
 * F-PR-05a — the work order's health (the container's part; the view draws the band chips and the Overview's Health card): reads each
 * of its own orders' health once the work order is read and again after each change of it (its version), raises to At risk and
 * clears with the production state's version as read (a stale one is refused in words and read again), one write at a time.
 */
export function useBrandHealth(api: ApiClient, workOrder: WorkOrder | null, permissions: readonly string[], onNotice: (words: Phrase) => void): { model: HealthModel; actions: HealthActions } {
  const can = permissions.includes('production.brand.manage')
  const orders = useMemo(() => (workOrder ? healthOrdersOf(workOrder) : []), [workOrder])
  const ordersKey = orders.map((order) => order.orderId).join(',')
  const [parts, setParts] = useState<HealthPart[]>([])
  const [dialog, setDialog] = useState<{ orderId: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const turn = useRef(0)
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice

  const read = useCallback(() => {
    const mine = ++turn.current
    const asked = ordersKey ? ordersKey.split(',') : []
    const numbers = new Map(orders.map((order) => [order.orderId, order.number]))
    setParts(asked.map((orderId) => ({ orderId, number: numbers.get(orderId) ?? '—', read: { value: null, problem: null } })))
    for (const orderId of asked) {
      getBrandHealth(api, orderId)
        .then((value) => mine === turn.current && setParts((current) => current.map((part) => (part.orderId === orderId ? { ...part, read: { value, problem: null } } : part))))
        .catch((error: unknown) => mine === turn.current && setParts((current) => current.map((part) => (part.orderId === orderId ? { ...part, read: { value: null, problem: readProblem(error) } } : part))))
    }
  }, [api, ordersKey])

  useEffect(() => {
    read()
  }, [read, workOrder?.version])

  const write = useCallback(
    async (orderId: string, run: (version: number | null) => Promise<HealthPart['read']['value']>, done: Phrase) => {
      if (busy) return
      const version = parts.find((part) => part.orderId === orderId)?.read.value?.version ?? null
      setBusy(true)
      setProblem(null)
      try {
        const value = await run(version)
        setParts((current) => current.map((part) => (part.orderId === orderId ? { ...part, read: { value, problem: null } } : part)))
        setDialog(null)
        noticeRef.current(done)
      } catch (error) {
        setProblem(raiseProblem(error))
        // A stale version or a state that changed meanwhile: read the order again (the dialog stays with the words).
        read()
      } finally {
        setBusy(false)
      }
    },
    [busy, parts, read],
  )

  const actions: HealthActions = {
    onDialog: (orderId) => {
      setProblem(null)
      setDialog(orderId ? { orderId } : null)
    },
    onRaise: (input) => void write(input.orderId, (version) => raiseBrandHealth(api, input.orderId, { reasonCode: input.reasonCode, note: input.note, version }, newIdempotencyKey()), { key: 'health.raisedNotice' }),
    onClear: (orderId) => void write(orderId, (version) => clearBrandHealth(api, orderId, version, newIdempotencyKey()), { key: 'health.clearedNotice' }),
    onRetry: read,
  }
  return { model: { orders: parts, can, dialog, busy, problem }, actions }
}
