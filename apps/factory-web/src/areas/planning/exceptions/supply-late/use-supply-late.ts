'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { checkSupplyLate, supplyLateFixes, supplyLateList, type SupplyLate, type SupplyLateList } from './api'
import { supplyLateCan, type SupplyLateCan } from './model'

/** One read's state: a failed read is never drawn as empty. */
export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

/** The supply-too-late slot of the Exceptions view model (B-W2b-336). */
export interface SupplyLateSlot {
  can: SupplyLateCan
  /** GET /planning/exceptions/supply-late: the tile's count and every open one with its fixes. */
  list: Loaded<SupplyLateList>
  /** The open detail's fixes, read fresh (`GET /planning/exceptions/:id/fixes`); the list's meanwhile. */
  detail: { id: string; loaded: Loaded<SupplyLate> } | null
  checking: boolean
  /** What the last Check now found (raised, still open, cleared). */
  checked: { raised: number; stillOpen: number; cleared: number } | null
  /** A refused Check now, in words (a key of `planning-promise`). */
  problem: string | null
}

export interface SupplyLateActions {
  /** The tile pressed: the queue shows supply too late (again: every kind). */
  onTile?: () => void
  onCheck?: (purchaseOrderId: string) => void
  onRetry?: () => void
  onRetryDetail?: () => void
}

const problemOf = (error: unknown): string => {
  if (!isApiError(error)) return 'supplyLate.error.failed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'supplyLate.error.forbidden'
  if (error.kind === 'unavailable') return 'supplyLate.error.offline'
  if (error.kind === 'not_found') return 'supplyLate.error.gone'
  return 'supplyLate.error.failed'
}

/** The events that can raise, keep or clear a supply-too-late exception (the supplier's dates, a run). */
const SUPPLY_EVENTS = ['supply_late.checked', 'purchase_order.', 'planning.run_finished', 'planning.exceptions_']

/**
 * The container part of supply too late on Planning › Exceptions: reads the site's supply-late list (the tile and the fixes),
 * the open detail's fixes fresh when a SUPPLY_LATE exception opens, Check now (one Idempotency-Key per purchase order and
 * try), and listens: a supplier's new date checked (`supply_late.checked`) or a purchase order's change reads it again, and a
 * new item tells the page ("1 update · Show", the queue never moves under the cursor).
 */
export function useSupplyLate(input: {
  api: ApiClient
  permissions: readonly string[]
  siteId: string | null
  /** The open detail and its kind. */
  open: { id: string; kind: string } | null
  /** A new supply-too-late item may be in the queue: the page counts an update. */
  onNewItem: () => void
  /** Check now changed the queue: the page reads it again. */
  onChecked: () => void
  enabled: boolean
}): { slot: SupplyLateSlot; actions: Omit<SupplyLateActions, 'onTile'> } {
  const { api, siteId, open, enabled } = input
  const can = useMemo(() => supplyLateCan(input.permissions), [input.permissions])
  const [list, setList] = useState<Loaded<SupplyLateList>>({ status: 'loading' })
  const [detail, setDetail] = useState<SupplyLateSlot['detail']>(null)
  const [checking, setChecking] = useState(false)
  const [checked, setChecked] = useState<SupplyLateSlot['checked']>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const reads = useRef({ list: 0, detail: 0 })
  const keys = useRef<Record<string, string>>({})
  /** This page's own Check now: its live echo is not "a new item" (the queue was read with it). */
  const ownCheckAt = useRef(0)
  const latest = useRef(input)
  latest.current = input
  const listRef = useRef(list)
  listRef.current = list

  const load = useCallback(async () => {
    if (!siteId || !enabled) return
    const id = ++reads.current.list
    try {
      const value = await supplyLateList(api, siteId)
      if (id === reads.current.list) setList({ status: 'ready', value })
    } catch (error) {
      if (id === reads.current.list) setList({ status: 'error', problem: problemOf(error) })
    }
  }, [api, siteId, enabled])

  useEffect(() => {
    setList({ status: 'loading' })
    setChecked(null)
    void load()
  }, [load])

  const loadDetail = useCallback(
    async (exceptionId: string) => {
      const id = ++reads.current.detail
      const known = listRef.current.status === 'ready' ? listRef.current.value.exceptions.find((entry) => entry.id === exceptionId) : undefined
      setDetail({ id: exceptionId, loaded: known ? { status: 'ready', value: known } : { status: 'loading' } })
      try {
        const value = await supplyLateFixes(api, exceptionId)
        if (id === reads.current.detail) setDetail({ id: exceptionId, loaded: { status: 'ready', value } })
      } catch (error) {
        if (id === reads.current.detail && !known) setDetail({ id: exceptionId, loaded: { status: 'error', problem: problemOf(error) } })
      }
    },
    [api],
  )

  const openId = open && open.kind === 'SUPPLY_LATE' ? open.id : null
  useEffect(() => {
    if (!openId || !enabled) {
      reads.current.detail += 1
      setDetail(null)
      setProblem(null)
      return
    }
    void loadDetail(openId)
  }, [openId, enabled, loadDetail])

  const check = useCallback(
    async (purchaseOrderId: string) => {
      if (checking || !can.check) return
      setChecking(true)
      setProblem(null)
      try {
        const answer = await checkSupplyLate(api, purchaseOrderId, (keys.current[purchaseOrderId] ??= newIdempotencyKey()))
        delete keys.current[purchaseOrderId]
        ownCheckAt.current = Date.now()
        setList({ status: 'ready', value: answer.view })
        setChecked({ raised: answer.raised, stillOpen: answer.stillOpen, cleared: answer.cleared })
        latest.current.onChecked()
        if (openId) void loadDetail(openId)
      } catch (error) {
        setProblem(problemOf(error).replace('supplyLate.error.', 'supplyLate.refusal.'))
      } finally {
        setChecking(false)
      }
    },
    [api, can.check, checking, openId, loadDetail],
  )

  const reread = useCoalesced(() => {
    void load()
    const id = latest.current.open
    if (id && id.kind === 'SUPPLY_LATE') void loadDetail(id.id)
  }, 800)
  useLive(
    (change) => {
      if (!SUPPLY_EVENTS.some((prefix) => change.type.startsWith(prefix))) return
      const own = change.fields.siteId === undefined || change.fields.siteId === null || change.fields.siteId === siteId
      if (!own) return
      reread()
      if (change.type === 'supply_late.checked' && Date.now() - ownCheckAt.current > 5000) latest.current.onNewItem()
    },
    () => void load(),
    enabled && !!siteId,
  )

  return {
    slot: { can, list, detail, checking, checked, problem },
    actions: {
      onCheck: (purchaseOrderId) => void check(purchaseOrderId),
      onRetry: () => void load(),
      onRetryDetail: () => openId && void loadDetail(openId),
    },
  }
}
