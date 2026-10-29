'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useT } from '../../../lib/i18n/provider'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import type { TaskProblem } from '../shared/task-api'
import { fetchPickList, fetchPickWorkOrders, issueStock, undoLastIssue } from './api'
import { num, padBounds, quantityText, stockOfScan, undoStock, withLine, type PickList, type PickWorkOrderRow } from './model'
import { PickView, type PickAction, type PickLast, type PickPad } from './view/PickView'

/**
 * The live SCR-093 (`/floor/pick`): for which work order (its traveller scanned here or on Home, or a row of the site's
 * released work orders), its pick list, and the scan that issues. A hide is issued whole by its scan; a lot or a material
 * opens the pad, defaulted to what is still needed. Every issue is ONE call with its own Idempotency-Key (kept for a
 * retry), recorded by the office at once (two ticks) or refused in words; the pick list is read again after each. Undo
 * the last issue in one tap. A code that is no work order number is handed on to Scan anything. Issuing needs the
 * network: offline the screen keeps the last lists it read (this visit only, with their time) and holds the scan.
 */

// The lists read on this tablet during the visit (offline they stay on screen with their time; nothing is stored).
const WORK_ORDERS = new AsOfMemory<PickWorkOrderRow[]>(8)
const LISTS = new AsOfMemory<PickList>(40)

type Stage = 'choose' | 'list'

export function FloorPick() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const t = useT('floor-issue')
  const { frame, onFrame } = store.frame('tile.pick', { showHome: true })
  const { me, api, online, sessionEnded } = store
  const siteId = me?.site.id ?? ''
  const may = Boolean(me?.permissions.includes('inventory.issue'))

  const [stage, setStage] = useState<Stage>('choose')
  const [workOrders, setWorkOrders] = useState<PickWorkOrderRow[] | null>(null)
  const [list, setList] = useState<PickList | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notOnTablet, setNotOnTablet] = useState(false)
  const [pad, setPad] = useState<PickPad | null>(null)
  const [last, setLast] = useState<PickLast | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ problem: TaskProblem; code: string | null } | null>(null)
  const started = useRef(false)

  const fail = useCallback(
    (found: TaskProblem, code: string | null) => {
      if (found.kind === 'signedOut') return void sessionEnded()
      feedback(found.kind === 'offline' || found.kind === 'unavailable' ? 'warning' : 'error')
      setProblem({ problem: found, code })
    },
    [feedback, sessionEnded],
  )

  const loadWorkOrders = useCallback(async () => {
    setNotOnTablet(false)
    if (!navigator.onLine) {
      const kept = WORK_ORDERS.get(siteId)
      setWorkOrders(kept?.value ?? [])
      setAsOf(kept?.asOf ?? null)
      setNotOnTablet(!kept)
      return
    }
    setWorkOrders(null)
    const answer = await fetchPickWorkOrders(api)
    if (!answer.ok) {
      const kept = WORK_ORDERS.get(siteId)
      if (kept && (answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable')) {
        setWorkOrders(kept.value)
        setAsOf(kept.asOf)
        return
      }
      setWorkOrders([])
      return fail(answer.problem, null)
    }
    WORK_ORDERS.keep(siteId, answer.value)
    setWorkOrders(answer.value)
    setAsOf(null)
  }, [api, fail, siteId])

  const openList = useCallback(
    async (workOrderId: string, number: string | null = null) => {
      setPad(null)
      if (!navigator.onLine) {
        const kept = LISTS.get(workOrderId)
        if (!kept) return fail({ kind: 'offline' }, number)
        setList(kept.value)
        setAsOf(kept.asOf)
        setStage('list')
        return
      }
      const answer = await fetchPickList(api, workOrderId)
      if (!answer.ok) return fail(answer.problem, number)
      LISTS.keep(workOrderId, answer.value)
      setList(answer.value)
      setAsOf(null)
      setStage('list')
    },
    [api, fail],
  )

  /** A scanned work order number: its pick list; no work order of this site: Scan anything takes the code. */
  const openNumber = useCallback(
    async (code: string) => {
      if (!navigator.onLine) {
        const row = WORK_ORDERS.get(siteId)?.value.find((entry) => codeKey(entry.number) === codeKey(code))
        return row ? openList(row.id, row.number) : fail({ kind: 'offline' }, code)
      }
      const answer = await fetchPickWorkOrders(api, code)
      if (!answer.ok) return fail(answer.problem, code)
      const row = answer.value[0]
      if (!row) return store.openScan(code)
      feedback('success')
      setLast(null)
      return openList(row.id, row.number)
    },
    [api, fail, feedback, openList, siteId, store],
  )

  const refresh = useCallback(
    async (workOrderId: string) => {
      const answer = await fetchPickList(api, workOrderId)
      if (answer.ok) {
        LISTS.keep(workOrderId, answer.value)
        setList(answer.value)
        setAsOf(null)
      }
    },
    [api],
  )

  const issue = useCallback(
    async (current: PickList, code: string, quantity?: { value: number; decimals: number }) => {
      setBusy(code)
      const answer = await issueStock(api, current.workOrder.id, { code, ...(quantity ? { quantity: quantityText(quantity.value, quantity.decimals) } : {}) }, newIdempotencyKey())
      setBusy(null)
      if (!answer.ok) {
        // A 400 that names the stock: no hide, lot or material of this site. A work order's number goes to its list.
        if (answer.problem.kind === 'invalid') {
          const other = await fetchPickWorkOrders(api, code)
          const row = other.ok ? other.value[0] : undefined
          if (row) return openList(row.id, row.number)
          return fail({ kind: 'refused', code: 'NOT_STOCK', message: t('notStock.message'), fix: t('notStock.fix') }, code)
        }
        return fail(answer.problem, code)
      }
      const { issue: done, line } = answer.value
      const target = current.lines.find((entry) => entry.itemId === done.itemId && entry.itemColourId === done.itemColourId)
      feedback('success')
      setPad(null)
      setLast({ kind: 'issued', code, quantity: num(done.baseQuantity), uom: target?.baseUom ?? '', workOrder: current.workOrder.number })
      if (target) setList(withLine(current, target.key, line))
      await refresh(current.workOrder.id)
    },
    [api, fail, feedback, openList, refresh, t],
  )

  const onScan = useCallback(
    async (code: string) => {
      if (!me) return
      const read = readScan(code, me.scanTag)
      if (read.kind === 'badge') {
        const refused = await store.switchTo(read.code)
        if (refused) fail({ kind: 'refused', code: 'BADGE', message: t('badge.message'), fix: t('badge.fix') }, null)
        return
      }
      setProblem(null)
      if (stage === 'choose' || !list) return openNumber(read.code)
      if (!navigator.onLine) {
        feedback('warning')
        return
      }
      const stock = stockOfScan(list, read)
      if (stock.kind === 'quantity') {
        const bounds = padBounds(stock.line, stock.onHand)
        feedback(bounds.covered ? 'warning' : 'success')
        setLast(null)
        return setPad({ code: stock.code, lineKey: stock.line.key, value: bounds.covered ? null : bounds.suggested, bounds, uom: stock.line.baseUom })
      }
      return issue(list, stock.code)
    },
    [fail, feedback, issue, list, me, openNumber, stage, store, t],
  )

  const undo = useCallback(async () => {
    if (!list?.undo) return
    const what = undoStock(list)
    setBusy('undo')
    const answer = await undoLastIssue(api, list.undo.issueId, newIdempotencyKey())
    setBusy(null)
    if (!answer.ok) return fail(answer.problem, what?.code ?? null)
    feedback('success')
    setLast({ kind: 'undone', code: what?.code ?? '—', quantity: num(answer.value.reversal.baseQuantity), uom: what?.line?.baseUom ?? '' })
    await refresh(list.workOrder.id)
  }, [api, fail, feedback, list, refresh])

  const done = useCallback(() => {
    setStage('choose')
    setList(null)
    setPad(null)
    setLast(null)
    void loadWorkOrders()
  }, [loadWorkOrders])

  // A code handed from Home opens its work order; else the site's list.
  useEffect(() => {
    if (started.current || !me || !may) return
    started.current = true
    const code = store.takeScan()
    void loadWorkOrders()
    if (code) void openNumber(code)
  }, [loadWorkOrders, may, me, openNumber, store])

  // Back online: what is on screen is read again (it was this tablet's copy).
  useEffect(() => {
    if (!online || !asOf || !may) return
    if (stage === 'list' && list) void refresh(list.workOrder.id)
    else void loadWorkOrders()
    // Only the network coming back reads again (not every change of the lists themselves).
  }, [online])

  const onAction = (action: PickAction) => {
    switch (action.type) {
      case 'scan':
        return void onScan(action.code)
      case 'open':
        setProblem(null)
        setLast(null)
        return void openList(action.workOrderId)
      case 'material': {
        const line = list?.lines.find((entry) => entry.key === action.lineKey)
        if (!line) return
        const bounds = padBounds(line, num(line.usable.onHand))
        return setPad({ code: line.itemCode, lineKey: line.key, value: bounds.covered ? null : bounds.suggested, bounds, uom: line.baseUom })
      }
      case 'pad':
        return setPad((current) => (current ? { ...current, value: action.value } : current))
      case 'issue':
        if (!list || !pad || pad.value === null || pad.bounds.covered || busy || !navigator.onLine) return
        if (pad.value < pad.bounds.min || pad.value > pad.bounds.max) return
        return void issue(list, pad.code, { value: pad.value, decimals: pad.bounds.decimals })
      case 'cancelPad':
        return setPad(null)
      case 'undo':
        return void undo()
      case 'done':
        return done()
      case 'dismiss':
        return setProblem(null)
      case 'retry':
        setProblem(null)
        if (stage === 'list' && list) return void openList(list.workOrder.id, list.workOrder.number)
        return void loadWorkOrders()
    }
  }

  useFloorKeys({
    enter: problem ? () => onAction({ type: 'dismiss' }) : pad ? () => onAction({ type: 'issue' }) : stage === 'list' ? done : null,
    escape: problem ? () => onAction({ type: 'dismiss' }) : pad ? () => setPad(null) : stage === 'list' ? done : () => router.push('/floor'),
  })

  if (!me) return null
  return (
    <PickView
      model={{
        frame,
        online,
        held: me.notice.blocksScans,
        stage: may ? stage : 'noPermission',
        workOrders,
        asOf,
        notOnTablet,
        list,
        pad,
        last,
        busy,
        problem,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
