'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { formatNumber } from '../../../lib/i18n/format'
import { useT } from '../../../lib/i18n/provider'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import type { TaskProblem } from '../shared/task-api'
import { fetchLabelPrinters, fetchPickList, fetchPickWorkOrders, fetchReturnPlaces, issueStock, printRemnantTag, readTagJob, retryTagJob, returnUnused, undoLastIssue, type ReturnPlace, type TagJob } from './api'
import { num, padBounds, quantityText, stockOfScan, undoStock, withLine, type PickList, type PickWorkOrderRow } from './model'
import { comesBackAs, remnantLabel, returnBody, returnBounds, returnOfScan, returnRows, tagPrinterOf, type ReturnRow } from './returns'
import { PickView, unitWord, type PickAction, type PickLast, type PickPad } from './view/PickView'
import type { PickReturnModel, ReturnTag } from './view/ReturnStep'

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
/** B-W2a-75: the site's storage places, read once a visit for Return unused. */
const PLACES = new AsOfMemory<ReturnPlace[]>(4)
const TAG_POLL_MS = 3_000
const TAG_POLL_TRIES = 40

type Stage = 'choose' | 'list' | 'return'

/** B-W2a-75: the Return unused step as the container keeps it (the view's model is built from it and the pick list). */
interface ReturnState {
  readonly picked: { readonly rowKey: string; readonly value: number | null } | null
  readonly places: readonly ReturnPlace[] | null
  readonly placesHeld: 'noPermission' | 'unavailable' | null
  readonly placeId: string | null
  readonly busy: boolean
  readonly problem: { readonly problem: TaskProblem; readonly code: string | null } | null
  readonly key: string
  readonly done: { readonly row: ReturnRow; readonly quantity: number; readonly place: string; readonly as: 'whole' | 'remnant' | 'part'; readonly tag: ReturnTag | null; readonly job: TagJob | null; readonly tagKey: string } | null
}

export function FloorPick() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const t = useT('floor-issue')
  const { frame, onFrame } = store.frame('tile.pick', { showHome: true })
  const { me, api, online, sessionEnded, locale } = store
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
    [fail, feedback, issue, list, me, openNumber, pickReturn, ret, rows, stage, store, t],
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
    setRet({ ...ret, busy: false, problem: null, done: { row, quantity: value, place: place.code, as, tag, job: null, tagKey: newIdempotencyKey() } })
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
    const answer = await printRemnantTag(api, { printerId, hideId: done.row.stock.hideId, label: remnantLabel(done.row, area, locale === 'en' ? 'en' : 'it') }, done.tagKey)
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
        ret: returnModel,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
