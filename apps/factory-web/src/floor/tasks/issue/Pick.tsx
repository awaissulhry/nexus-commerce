'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { formatNumber } from '../../../lib/i18n/format'
import { useT } from '../../../lib/i18n/provider'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import type { TaskProblem } from '../shared/task-api'
import { fetchLabelPrinters, fetchPickList, fetchPickWorkOrders, fetchReturnPlaces, issueStock, printRemnantTag, readTagJob, retryTagJob, returnUnused, undoLastIssue, type ReturnPlace, type TagJob } from './api'
import { num, padBounds, quantityText, stockOfScan, undoStock, withLine, type PickList, type PickWorkOrderRow } from './model'
import { comesBackAs, remnantLabel, returnBody, returnBounds, returnOfScan, returnRows, tagPrinterOf, type ReturnRow } from './returns'
import { PickView, unitWord, type PickAction, type PickLast, type PickPad } from './view/PickView'
import type { PickReturnModel, ReturnTag } from './view/ReturnStep'
// B-W2b-310: the pick list by bin and kit staging.
import { queuedView } from '../shared/queued'
import { completeKit, placeOfLabel, stageKit } from './kit/api'
import { kitOf, type KitLast } from './kit/model'
import { fetchWalk, keptWalk, pickOrKeep, substituteOrKeep } from './picklist/api'
import { takeHandedWorkOrder } from './picklist/handoff'
import { HELD_CODE, stopBody, stopBounds, stopHeld, stopKey, stopOfScan, takesWhole, type Walk, type WalkStop } from './picklist/model'

/**
 * The live SCR-093 (`/floor/pick`): for which work order (its traveller scanned here or on Home, or a row of the site's
 * released work orders), its pick list, and the scan that issues. A hide is issued whole by its scan; a lot or a material
 * opens the pad, defaulted to what is still needed. Every issue is ONE call with its own Idempotency-Key (kept for a
 * retry), recorded by the office at once (two ticks) or refused in words; the pick list is read again after each. Undo
 * the last issue in one tap. A code that is no work order number is handed on to Scan anything. Issuing needs the
 * network: offline the screen keeps the last lists it read (this visit only, with their time) and holds the scan.
 *
 * B-W2b-310: the work order's pick list by bin is read beside its pick list (and kept for the visit): a code scanned that is a stop
 * of the walk is taken from that stop's place (a hide whole, a lot on the pad defaulted to the stop's quantity, an approved
 * substitute by its own issue), online first, else kept in the tablet's queue (inventory.pick.issue | inventory.substitute.issue)
 * — so with the walk on this tablet a pick goes on offline. Kit staging (online only): the kit's place by its label's scan, and
 * "Kit complete". A PICK task handed from My work opens its work order.
 */

// The lists read on this tablet during the visit (offline they stay on screen with their time; nothing is stored).
const WORK_ORDERS = new AsOfMemory<PickWorkOrderRow[]>(8)
const LISTS = new AsOfMemory<PickList>(40)
/** B-W2a-75: the site's storage places, read once a visit for Return unused. */
const PLACES = new AsOfMemory<ReturnPlace[]>(4)
const TAG_POLL_MS = 3_000
const TAG_POLL_TRIES = 40

type Stage = 'choose' | 'list' | 'return' | /* B-W2b-310 */ 'kit'

/** B-W2a-75: the Return unused step as the container keeps it (the view's model is built from it and the pick list). */
interface ReturnState {
  readonly picked: { readonly rowKey: string; readonly value: number | null } | null
  readonly places: readonly ReturnPlace[] | null
  readonly placesHeld: 'noPermission' | 'unavailable' | null
  readonly placeId: string | null
  readonly busy: boolean
  readonly problem: { readonly problem: TaskProblem; readonly code: string | null } | null
  readonly key: string
  readonly done: { readonly row: ReturnRow; readonly quantity: number; readonly place: string; readonly as: 'whole' | 'remnant' | 'part'; readonly tag: ReturnTag | null; readonly job: TagJob | null; readonly tagKey: string; readonly remnantCode?: string | null } | null
}

export function FloorPick() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const t = useT('floor-issue')
  const { frame, onFrame } = store.frame('tile.pick', { showHome: true })
  const { me, api, online, sessionEnded, locale, queue, queueSnapshot } = store
  const deviceId = store.device?.device.id ?? null
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
  const [ret, setRet] = useState<ReturnState | null>(null)
  // B-W2b-310: the walk of the work order on screen, the stops this tablet took that it has not read back, Kit staging.
  const [walk, setWalk] = useState<Walk | null>(null)
  const [walkAsOf, setWalkAsOf] = useState<string | null>(null)
  const [taken, setTaken] = useState<ReadonlySet<string>>(new Set())
  const [kitBusy, setKitBusy] = useState(false)
  const [kitLast, setKitLast] = useState<KitLast | null>(null)
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

  /** B-W2b-310: the work order's walk, read beside its pick list (offline: the one this tablet read, else none). */
  const loadWalk = useCallback(
    async (workOrderId: string) => {
      if (!navigator.onLine) {
        const kept = keptWalk(workOrderId)
        setWalk(kept?.value ?? null)
        setWalkAsOf(kept?.asOf ?? null)
        return
      }
      const answer = await fetchWalk(api, workOrderId)
      if (answer.ok) {
        setWalk(answer.value)
        setWalkAsOf(null)
        setTaken(new Set())
        return
      }
      const kept = answer.problem.kind === 'offline' ? keptWalk(workOrderId) : null
      setWalk(kept?.value ?? null)
      setWalkAsOf(kept?.asOf ?? null)
    },
    [api],
  )

  const openList = useCallback(
    async (workOrderId: string, number: string | null = null) => {
      setPad(null)
      setKitLast(null)
      if (!navigator.onLine) {
        const kept = LISTS.get(workOrderId)
        if (!kept) return fail({ kind: 'offline' }, number)
        setList(kept.value)
        setAsOf(kept.asOf)
        setStage('list')
        void loadWalk(workOrderId)
        return
      }
      const answer = await fetchPickList(api, workOrderId)
      if (!answer.ok) return fail(answer.problem, number)
      LISTS.keep(workOrderId, answer.value)
      setList(answer.value)
      setAsOf(null)
      setStage('list')
      setTaken(new Set())
      void loadWalk(workOrderId)
    },
    [api, fail, loadWalk],
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
      // B-W2b-310: and its walk.
      await loadWalk(workOrderId)
    },
    [api, loadWalk],
  )

  // B-W2a-75: what the work order holds that may come back, and one of them picked for Return unused.
  const rows = useMemo(() => (list ? returnRows(list) : []), [list])
  const pickReturn = useCallback(
    (row: ReturnRow) => {
      feedback('success')
      setRet((current) => (current ? { ...current, picked: { rowKey: row.key, value: returnBounds(row).suggested }, problem: null, key: newIdempotencyKey() } : current))
    },
    [feedback],
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

  /** B-W2b-310: a stop of the walk taken by its scan: online first, else kept on this tablet (it may queue). */
  const issueStop = useCallback(
    async (current: PickList, stop: WalkStop, quantity?: { value: number; decimals: number }) => {
      const body = stopBody(stop, quantity)
      setBusy(body.code)
      const substitute = stop.source === 'SUBSTITUTE' && stop.substitutionId !== null
      const outcome = substitute ? await substituteOrKeep(api, queue, online, deviceId, stop.substitutionId!, body) : await pickOrKeep(api, queue, online, deviceId, current.workOrder.id, body)
      setBusy(null)
      const base = { kind: 'picked' as const, code: body.code, place: stop.location.code, uom: stop.baseUom, substitute }
      if (outcome.kept) {
        feedback('success')
        setPad(null)
        setTaken((before) => new Set([...before, stopKey(stop)]))
        return setLast({ ...base, quantity: body.quantity ?? null, ticks: 'saved', clientEventId: outcome.kept.clientEventId })
      }
      if (!outcome.answer.ok) return fail(outcome.answer.problem, body.code)
      feedback('success')
      setPad(null)
      setLast({ ...base, quantity: outcome.answer.value.quantity, ticks: 'recorded', clientEventId: null })
      await refresh(current.workOrder.id)
    },
    [api, deviceId, fail, feedback, online, queue, refresh],
  )

  /** B-W2b-310: what a stop's scan does: refused in words when it may not be taken now, a hide at once, a lot on the pad. */
  const takeStop = useCallback(
    (current: PickList, stop: WalkStop) => {
      const held = stopHeld(stop)
      if (held) return fail({ kind: 'refused', code: HELD_CODE[held], message: '', fix: null }, stop.lotCode ?? stop.hideCode ?? stop.location.code)
      if (takesWhole(stop)) return void issueStop(current, stop)
      const bounds = stopBounds(stop)
      const colour = walk?.lines.find((entry) => entry.key === stop.lineKey)?.itemColourId ?? null
      feedback(bounds.covered ? 'warning' : 'success')
      setLast(null)
      setPad({ code: stop.lotCode ?? stop.itemCode, lineKey: `${stop.itemId}:${colour ?? '-'}`, value: bounds.covered ? null : bounds.suggested, bounds, uom: stop.baseUom, stop: stopKey(stop) })
    },
    [fail, feedback, issueStop, walk],
  )

  /** B-W2b-310: Kit staging — the kit put at the place whose label was scanned (online only). */
  const stageAt = useCallback(
    async (code: string) => {
      if (!list || !walk || kitBusy || !navigator.onLine) return void feedback('warning')
      setKitBusy(true)
      try {
        const place = await placeOfLabel(api, code)
        if (!place.ok) return fail(place.problem, code)
        const answer = await stageKit(api, list.workOrder.id, { version: walk.kit.version, locationId: place.value.id }, newIdempotencyKey())
        if (!answer.ok) return fail(answer.problem, code)
        feedback('success')
        setWalk({ ...walk, kit: answer.value })
        setKitLast({ kind: 'staged', place: answer.value.location?.code ?? place.value.code })
      } finally {
        setKitBusy(false)
      }
    },
    [api, fail, feedback, kitBusy, list, walk],
  )

  const checkKit = useCallback(async () => {
    if (!list || !walk || kitBusy || !navigator.onLine) return void feedback('warning')
    setKitBusy(true)
    try {
      const answer = await completeKit(api, list.workOrder.id, { version: walk.kit.version }, newIdempotencyKey())
      if (!answer.ok) return fail(answer.problem, list.workOrder.number)
      feedback('success')
      setWalk({ ...walk, kit: answer.value })
      setKitLast({ kind: 'checked' })
    } finally {
      setKitBusy(false)
    }
  }, [api, fail, feedback, kitBusy, list, walk])

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
      if (stage === 'return' && list && ret) {
        if (ret.done || !navigator.onLine) return void feedback('warning')
        const row = returnOfScan(rows, read)
        if (row) return pickReturn(row)
        feedback('warning')
        return setRet({ ...ret, problem: { problem: { kind: 'refused', code: 'NOT_AT_WORK_ORDER', message: t('refusal.NOT_AT_WORK_ORDER.message'), fix: t('refusal.NOT_AT_WORK_ORDER.fix') }, code: read.code } })
      }
      if (stage === 'choose' || !list) return openNumber(read.code)
      // B-W2b-310: Kit staging takes a place's label; the pick list by bin takes what is taken at a stop (offline too).
      if (stage === 'kit') return stageAt(read.code)
      const stop = stopOfScan(walk, taken, read)
      if (stop) return takeStop(list, stop)
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
    [fail, feedback, issue, list, me, openNumber, pickReturn, ret, rows, stage, stageAt, store, t, takeStop, taken, walk],
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

  // ---- Return unused (B-W2a-75): pick what comes back, how much, where; then a remnant's new tag ----

  const openReturn = useCallback(async () => {
    if (!list || !navigator.onLine) return
    setPad(null)
    setLast(null)
    setProblem(null)
    setStage('return')
    const kept = PLACES.get(siteId)?.value ?? null
    setRet({ picked: null, places: kept, placesHeld: null, placeId: kept?.length === 1 ? kept[0]!.id : null, busy: false, problem: null, key: newIdempotencyKey(), done: null })
    if (kept) return
    const answer = await fetchReturnPlaces(api, siteId)
    if (!answer.ok && answer.problem.kind === 'signedOut') return void sessionEnded()
    if (answer.ok) PLACES.keep(siteId, answer.value)
    setRet((current) =>
      current
        ? answer.ok
          ? { ...current, places: answer.value, placeId: current.placeId ?? (answer.value.length === 1 ? answer.value[0]!.id : null) }
          : { ...current, placesHeld: answer.problem.kind === 'forbidden' ? 'noPermission' : 'unavailable' }
        : current,
    )
  }, [api, list, sessionEnded, siteId])

  /** A remnant's new tag: whether this app prints it here, and where. */
  const resolveTag = useCallback(
    async (row: ReturnRow, as: 'whole' | 'remnant' | 'part'): Promise<ReturnTag | null> => {
      if (row.kind !== 'hide' || as !== 'remnant' || !me) return null
      const read = readScan(row.code, me.scanTag)
      if (read.kind !== 'label' || read.type !== 'hide') return { kind: 'notOurs' }
      if (!me.permissions.includes('print.labels')) return { kind: 'noRight' }
      const answer = await fetchLabelPrinters(api, siteId, store.device?.device.station?.id ?? null)
      if (!answer.ok) return { kind: 'printer', printer: { kind: 'none' }, picked: null }
      const printer = tagPrinterOf(answer.value.printers, answer.value.stationPrinterId)
      return { kind: 'printer', printer, picked: printer.kind === 'station' || printer.kind === 'site' ? printer.id : null }
    },
    [api, me, siteId, store.device],
  )

  const confirmReturn = useCallback(async () => {
    if (!list || !ret?.picked || ret.busy || !navigator.onLine) return
    const row = rows.find((entry) => entry.key === ret.picked!.rowKey)
    const value = ret.picked.value
    const place = ret.places?.find((entry) => entry.id === ret.placeId)
    if (!row || value === null || !place) return
    const bounds = returnBounds(row)
    if (value < bounds.min || value > bounds.max) return
    setRet({ ...ret, busy: true, problem: null })
    const answer = await returnUnused(api, list.workOrder.id, returnBody(row, value, bounds.decimals, place.id, new Date().toISOString()), ret.key)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setRet({ ...ret, busy: false, problem: { problem: answer.problem, code: row.code }, key: newIdempotencyKey() })
    }
    feedback('success')
    const as = answer.value.hideState === 'REMNANT' ? 'remnant' : comesBackAs(row, value)
    const tag: ReturnTag | null = row.kind === 'hide' && as === 'remnant' ? { kind: 'looking' } : null
    setRet({ ...ret, busy: false, problem: null, done: { row, quantity: value, place: place.code, as, tag, job: null, tagKey: newIdempotencyKey(), remnantCode: answer.value.remnant?.code ?? null } })
    void refresh(list.workOrder.id)
    if (tag) {
      const resolved = await resolveTag(row, as)
      setRet((current) => (current?.done ? { ...current, done: { ...current.done, tag: resolved } } : current))
    }
  }, [api, feedback, list, refresh, resolveTag, ret, rows, sessionEnded])

  const printTag = useCallback(async () => {
    const done = ret?.done
    if (!done || done.tag?.kind !== 'printer' || done.tag.busy || !navigator.onLine) return
    const printerId = done.tag.printer.kind === 'station' || done.tag.printer.kind === 'site' ? done.tag.printer.id : done.tag.picked
    const printerName = done.tag.printer.kind === 'choose' ? (done.tag.printer.printers.find((printer) => printer.id === printerId)?.name ?? '') : done.tag.printer.kind === 'none' ? '' : done.tag.printer.name
    if (!printerId || !('hideId' in done.row.stock)) return
    const tagState = done.tag
    setRet({ ...ret!, done: { ...done, tag: { ...tagState, busy: true, problem: null } } })
    const area = `${formatNumber(done.quantity, locale, { maximumFractionDigits: 2 })} ${unitWord(t, done.row.uom)}`
    const answer = await printRemnantTag(api, { printerId, hideId: done.row.stock.hideId, label: remnantLabel(done.row, area, locale === 'en' ? 'en' : 'it', done.remnantCode) }, done.tagKey)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      return setRet((current) => (current?.done ? { ...current, done: { ...current.done, tag: { ...tagState, busy: false, problem: answer.problem }, tagKey: newIdempotencyKey() } } : current))
    }
    feedback('success')
    setRet((current) => (current?.done ? { ...current, done: { ...current.done, job: answer.value, tag: { kind: 'job', printer: printerName, status: answer.value.status, detail: answer.value.lastError } } } : current))
  }, [api, feedback, locale, ret, sessionEnded, t])

  const retryTag = useCallback(async () => {
    const done = ret?.done
    if (!done?.job || done.tag?.kind !== 'job' || done.job.status !== 'FAILED' || !navigator.onLine) return
    const tagState = done.tag
    setRet({ ...ret!, done: { ...done, tag: { ...tagState, retrying: true } } })
    const answer = await retryTagJob(api, done.job, newIdempotencyKey())
    setRet((current) =>
      current?.done ? { ...current, done: { ...current.done, ...(answer.ok ? { job: answer.value } : {}), tag: answer.ok ? { ...tagState, status: answer.value.status, detail: answer.value.lastError, retrying: false } : { ...tagState, retrying: false } } } : current,
    )
    feedback(answer.ok ? 'success' : 'error')
  }, [api, feedback, ret])

  // The new tag on its way: its job read again every few seconds until it printed or failed.
  const tagJobId = ret?.done?.job && (ret.done.job.status === 'QUEUED' || ret.done.job.status === 'SENT') ? ret.done.job.id : null
  useEffect(() => {
    if (!tagJobId || !online) return
    let tries = 0
    const timer = window.setInterval(async () => {
      tries += 1
      if (tries > TAG_POLL_TRIES) return window.clearInterval(timer)
      const answer = await readTagJob(api, tagJobId)
      if (!answer.ok) return
      setRet((current) => (current?.done?.job?.id === tagJobId && current.done.tag?.kind === 'job' ? { ...current, done: { ...current.done, job: answer.value, tag: { ...current.done.tag, status: answer.value.status, detail: answer.value.lastError } } } : current))
    }, TAG_POLL_MS)
    return () => window.clearInterval(timer)
  }, [api, online, tagJobId])

  const backFromReturn = useCallback(() => {
    setRet(null)
    setStage('list')
  }, [])

  const done = useCallback(() => {
    setStage('choose')
    setRet(null)
    setList(null)
    setPad(null)
    setLast(null)
    // B-W2b-310
    setWalk(null)
    setWalkAsOf(null)
    setTaken(new Set())
    setKitLast(null)
    void loadWorkOrders()
  }, [loadWorkOrders])

  // B-W2b-310: a stop kept on this tablet — once the office recorded it, the lists are read again; a refusal says so on the strip.
  const keptId = last?.kind === 'picked' ? last.clientEventId : null
  const keptTicks = keptId ? (queuedView(queueSnapshot, keptId)?.ticks ?? null) : null
  useEffect(() => {
    if (keptTicks === 'recorded' && online && list) void refresh(list.workOrder.id)
    // Only the queue's word on the kept stop moves it on.
  }, [keptTicks])

  // A code handed from Home opens its work order; else the site's list.
  useEffect(() => {
    if (started.current || !me || !may) return
    started.current = true
    const code = store.takeScan()
    void loadWorkOrders()
    // B-W2b-310: a PICK task handed from My work opens its work order's pick list.
    const handed = takeHandedWorkOrder()
    if (handed) return void openList(handed)
    if (code) void openNumber(code)
  }, [loadWorkOrders, may, me, openList, openNumber, store])

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
      case 'issue': {
        if (!list || !pad || pad.value === null || pad.bounds.covered || busy) return
        if (pad.value < pad.bounds.min || pad.value > pad.bounds.max) return
        // B-W2b-310: a stop's pad issues from that stop (online first, else kept on this tablet).
        const stop = pad.stop ? walk?.stops.find((entry) => stopKey(entry) === pad.stop) : undefined
        if (stop) return void issueStop(list, stop, { value: pad.value, decimals: pad.bounds.decimals })
        if (!navigator.onLine) return
        return void issue(list, pad.code, { value: pad.value, decimals: pad.bounds.decimals })
      }
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
        if ((stage === 'list' || stage === 'return') && list) return void openList(list.workOrder.id, list.workOrder.number)
        return void loadWorkOrders()
      case 'returnOpen':
        return void openReturn()
      case 'returnScan':
        return void onScan(action.code)
      case 'returnPick': {
        const row = rows.find((entry) => entry.key === action.rowKey)
        if (row && navigator.onLine) pickReturn(row)
        return
      }
      case 'returnValue':
        return setRet((current) => (current?.picked ? { ...current, picked: { ...current.picked, value: action.value } } : current))
      case 'returnPlace':
        return setRet((current) => (current ? { ...current, placeId: action.placeId } : current))
      case 'returnConfirm':
        return void confirmReturn()
      case 'returnUnpick':
        return setRet((current) => (current ? { ...current, picked: null, problem: null } : current))
      case 'returnAnother':
        return setRet((current) => (current ? { ...current, picked: null, problem: null, done: null, key: newIdempotencyKey() } : current))
      case 'returnBack':
        return backFromReturn()
      case 'tagPrinter':
        return setRet((current) => (current?.done?.tag?.kind === 'printer' ? { ...current, done: { ...current.done, tag: { ...current.done.tag, picked: action.printerId } } } : current))
      case 'tagPrint':
        return void printTag()
      case 'tagRetry':
        return void retryTag()
      // B-W2b-310: Kit staging.
      case 'kitOpen':
        if (!walk) return
        setPad(null)
        setProblem(null)
        setKitLast(null)
        return setStage('kit')
      case 'kitScan':
        return void onScan(action.code)
      case 'kitComplete':
        return void checkKit()
      case 'kitBack':
        setKitLast(null)
        return setStage('list')
    }
  }

  const returnModel: PickReturnModel | null =
    stage === 'return' && ret && list
      ? { workOrder: list.workOrder.number, rows, picked: ret.picked, places: ret.places, placesHeld: ret.placesHeld, placeId: ret.placeId, busy: ret.busy, problem: ret.problem, done: ret.done ? { row: ret.done.row, quantity: ret.done.quantity, place: ret.done.place, as: ret.done.as, tag: ret.done.tag } : null }
      : null
  const tagReady = ret?.done?.tag?.kind === 'printer' && ret.done.tag.printer.kind !== 'none'

  useFloorKeys({
    enter: problem
      ? () => onAction({ type: 'dismiss' })
      : /* B-W2b-310 */ stage === 'kit'
        ? () => void checkKit()
        : stage === 'return'
        ? ret?.done
          ? () => onAction({ type: tagReady ? 'tagPrint' : 'returnAnother' })
          : ret?.picked
            ? () => onAction({ type: 'returnConfirm' })
            : null
        : pad
          ? () => onAction({ type: 'issue' })
          : stage === 'list'
            ? done
            : null,
    escape: problem
      ? () => onAction({ type: 'dismiss' })
      : /* B-W2b-310 */ stage === 'kit'
        ? () => onAction({ type: 'kitBack' })
        : stage === 'return'
        ? ret?.picked && !ret.done
          ? () => onAction({ type: 'returnUnpick' })
          : backFromReturn
        : pad
          ? () => setPad(null)
          : stage === 'list'
            ? done
            : () => router.push('/floor'),
  })

  if (!me) return null
  const shownLast: PickLast | null = last?.kind === 'picked' && keptTicks && last.ticks !== 'recorded' ? { ...last, ticks: keptTicks } : last
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
        last: shownLast,
        busy,
        problem,
        ret: returnModel,
        // B-W2b-310
        walk: walk && list && walk.workOrder.id === list.workOrder.id ? { walk, taken } : null,
        kit: stage === 'kit' && walk && list ? { kit: kitOf(walk, list), busy: kitBusy, last: kitLast, asOf: walkAsOf } : null,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
