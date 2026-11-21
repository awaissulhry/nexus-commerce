'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../api/client'
import type { Phrase } from '../model'
import { clearBrandHealth, getBrandHealth, raiseBrandHealth, type BrandHealthView } from './api'
import { healthOrdersOf, healthReadProblem as readProblem, raiseProblem, type HealthActions, type HealthModel, type HealthOwner, type HealthPart } from './model'

/**
 * F-PR-05a — the work order's health (the container's part; the view draws the band chips and the Overview's Health card): reads each
 * of its own orders' health once the work order is read and again after each change of it (its version), raises to At risk and
 * clears with the production state's version as read (a stale one is refused in words and read again), one write at a time.
 */
// F-SA-235: `workOrder` is any owner of orders with a version — a work order (its orders) or a sales order ({ orders: [itself] }).
// F-PT-404 (B-PT-007): `known` — the page already read each order's health (the sales order's production read): no GET here; a write
// sends that read's version and `reread` reads the page's read again after it (done or refused). The work order page passes none.
export function useBrandHealth(
  api: ApiClient,
  workOrder: (HealthOwner & { readonly version: number }) | null,
  permissions: readonly string[],
  onNotice: (words: Phrase) => void,
  known?: { readonly views: ReadonlyMap<string, BrandHealthView>; readonly reread: () => void } | null,
): { model: HealthModel; actions: HealthActions } {
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

  const knownRef = useRef(known ?? null)
  knownRef.current = known ?? null
  const fromPage = !!known
  useEffect(() => {
    if (!fromPage) read()
  }, [read, workOrder?.version, fromPage])
  // F-PT-404: the page's own read, as the parts (no GET).
  const shown: HealthPart[] = known ? orders.map((order) => ({ orderId: order.orderId, number: order.number, read: { value: known.views.get(order.orderId) ?? null, problem: null } })) : parts
  const again = useCallback(() => (knownRef.current ? knownRef.current.reread() : read()), [read])

  const write = useCallback(
    async (orderId: string, run: (version: number | null) => Promise<HealthPart['read']['value']>, done: Phrase) => {
      if (busy) return
      const version = shown.find((part) => part.orderId === orderId)?.read.value?.version ?? null
      setBusy(true)
      setProblem(null)
      try {
        const value = await run(version)
        setParts((current) => current.map((part) => (part.orderId === orderId ? { ...part, read: { value, problem: null } } : part)))
        setDialog(null)
        noticeRef.current(done)
        // F-PT-404: the page's read again (its headline carries the new mark and version).
        if (knownRef.current) knownRef.current.reread()
      } catch (error) {
        setProblem(raiseProblem(error))
        // A stale version or a state that changed meanwhile: read the order again (the dialog stays with the words).
        again()
      } finally {
        setBusy(false)
      }
    },
    [busy, shown, again],
  )

  const actions: HealthActions = {
    onDialog: (orderId) => {
      setProblem(null)
      setDialog(orderId ? { orderId } : null)
    },
    onRaise: (input) => void write(input.orderId, (version) => raiseBrandHealth(api, input.orderId, { reasonCode: input.reasonCode, note: input.note, version }, newIdempotencyKey()), { key: 'health.raisedNotice' }),
    onClear: (orderId) => void write(orderId, (version) => clearBrandHealth(api, orderId, version, newIdempotencyKey()), { key: 'health.clearedNotice' }),
    onRetry: again,
  }
  return { model: { orders: shown, can, dialog, busy, problem }, actions }
}
