'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useT } from '../../../lib/i18n/provider'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey, type Remembered } from '../shared/as-of'
import { queuedView } from '../shared/queued'
import type { TaskProblem } from '../shared/task-api'
import { fetchOrder, fetchTicketJobs, fetchWorkOrders, reprintBundle, retryJob, scanBundle, voidBundle, type BundleOrder, type BundleWorkOrder, type ScannedBundle } from './api'
import {
  editQuantity,
  jobMoving,
  jobOfCode,
  maxAt,
  nextBundleSize,
  pendingByCell,
  proposalOf,
  REPRINT_REASONS,
  ticketPrint,
  uncounted,
  VOID_REASONS,
  type JobState,
  type MadeTicket,
  type TicketContent,
  type VoidReason,
} from './model'
import { BundlesView, refusalWords, type BundleDone, type BundlesAction, type BundlesStep, type CardModel, type PrinterModel, type TicketModel } from './view/BundlesView'

/**
 * The live SCR-095 (`/floor/bundles`): a cutting table's bundles and tickets. Reads go to the bundles module (and the
 * print queue for each ticket's job); "Make N bundles" saves N events of the queued kind `production.bundles.make` on
 * the tablet (ONE bundle each, its ticket numbered from the tablet's own BUNDLE block), so it works offline and the
 * screen shows each ticket's two ticks, then its print job once the office recorded the bundle. Reprint and void are
 * online only (held with the reason). What the tablet read stays known for the rest of the visit (as of its time), so
 * a work order opened online can still be bundled offline.
 */

/** What this tab has read, kept for the visit (tasks/shared/as-of.ts). */
const LIST = new AsOfMemory<BundleWorkOrder[]>(1)
const ORDERS = new AsOfMemory<BundleOrder>(50)
const CARDS = new AsOfMemory<ScannedBundle>(100)
/** The bundles this tab made, oldest first (their tickets stay on the work order's screen for the visit). */
const MADE: MadeTicket[] = []
/** The makes each work order's last read counts. */
const COUNTED = new Map<string, Set<string>>()

/** How long a ticket's print job is watched after the office recorded it (then the office's queue has it). */
const WATCH_MS = 3 * 60_000
const POLL_MS = 4_000

type Back = { kind: 'pick' } | { kind: 'order'; workOrderId: string }

type Screen =
  | { kind: 'loading'; code: string | null }
  | { kind: 'pick' }
  | { kind: 'order'; workOrderId: string }
  | { kind: 'bundle'; key: string; stage: 'card' | 'reprint' | 'void'; reason: VoidReason | null; busy: boolean; done: Done | null; problem: TaskProblem | null; writeKey: string; back: Back }
  | { kind: 'problem'; problem: TaskProblem; code: string | null; again: (() => void) | null; back: Back | null }

type Done = { kind: 'reprinted'; replacedCode: string; bundleId: string; ticket: TicketContent; printProblem: string | null } | { kind: 'voided'; code: string; quantity: number }

const cellLabel = (cell: { colourwayCode: string; size: string }) => `${cell.colourwayCode} ${cell.size}`

export function FloorBundles() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const t = useT('floor-bundles')
  const { frame, onFrame } = store.frame('tile.bundles', { showHome: true })
  const { me, api, online, queue, queueSnapshot } = store
  const permissions = useMemo(() => new Set(me?.permissions ?? []), [me?.permissions])
  const allowed = permissions.has('production.bundles')
  const seesJobs = permissions.has('print.view')

  const [screen, setScreen] = useState<Screen>({ kind: 'loading', code: null })
  const [, setVersion] = useState(0)
  const bump = useCallback(() => setVersion((value) => value + 1), [])
  const [sizes, setSizes] = useState<ReadonlyMap<string, number>>(new Map())
  const [overrides, setOverrides] = useState<ReadonlyMap<string, readonly number[]>>(new Map())
  const [editing, setEditing] = useState<{ workOrderId: string; cellId: string; index: number; value: number | null } | null>(null)
  const [printers, setPrinters] = useState<ReadonlyMap<string, string>>(new Map())
  const [making, setMaking] = useState(false)
  const [jobs, setJobs] = useState<ReadonlyMap<string, readonly JobState[]>>(new Map())
  const [retrying, setRetrying] = useState<ReadonlySet<string>>(new Set())
  const watchedSince = useRef(new Map<string, number>())
  const taken = useRef(false)

  const fail = useCallback(
    (problem: TaskProblem, code: string | null, again: (() => void) | null, back: Back | null) => {
      if (problem.kind === 'signedOut') return void store.sessionEnded()
      feedback(problem.kind === 'offline' || problem.kind === 'unavailable' ? 'warning' : 'error')
      setScreen({ kind: 'problem', problem, code, again, back })
    },
    [feedback, store],
  )

  // ---- reads ----

  const loadList = useCallback(async () => {
    if (!navigator.onLine) {
      if (LIST.get('all')) return setScreen({ kind: 'pick' })
      return fail({ kind: 'offline' }, null, () => void loadList(), null)
    }
    const answer = await fetchWorkOrders(api)
    if (!answer.ok) {
      if (LIST.get('all') && (answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable')) return setScreen({ kind: 'pick' })
      return fail(answer.problem, null, () => void loadList(), null)
    }
    LIST.keep('all', answer.value)
    setScreen({ kind: 'pick' })
  }, [api, fail])

  const readOrder = useCallback(
    async (workOrderId: string): Promise<TaskProblem | null> => {
      const recorded = new Set(queue.getSnapshot().items.filter((item) => item.state === 'recorded').map((item) => item.clientEventId))
      const answer = await fetchOrder(api, workOrderId)
      if (!answer.ok) return answer.problem
      ORDERS.keep(workOrderId, answer.value)
      COUNTED.set(workOrderId, new Set(MADE.filter((made) => made.workOrderId === workOrderId && recorded.has(made.clientEventId)).map((made) => made.clientEventId)))
      bump()
      return null
    },
    [api, bump, queue],
  )

  const openOrder = useCallback(
    async (workOrderId: string, back: Back | null = null) => {
      setEditing(null)
      if (!navigator.onLine) {
        if (ORDERS.get(workOrderId)) return setScreen({ kind: 'order', workOrderId })
        return fail({ kind: 'offline' }, null, () => void openOrder(workOrderId, back), back)
      }
      setScreen({ kind: 'loading', code: null })
      const problem = await readOrder(workOrderId)
      if (problem && !(ORDERS.get(workOrderId) && (problem.kind === 'offline' || problem.kind === 'unavailable'))) return fail(problem, null, () => void openOrder(workOrderId, back), back ?? { kind: 'pick' })
      setScreen({ kind: 'order', workOrderId })
    },
    [fail, readOrder],
  )

  const openNumber = useCallback(
    async (number: string, back: Back | null) => {
      const known = [...(LIST.get('all')?.value ?? [])].find((row) => row.number.toUpperCase() === number.toUpperCase())
      if (!navigator.onLine) {
        if (known && ORDERS.get(known.id)) return setScreen({ kind: 'order', workOrderId: known.id })
        return fail({ kind: 'offline' }, number, null, back)
      }
      setScreen({ kind: 'loading', code: number })
      const answer = await fetchWorkOrders(api, number)
      if (!answer.ok) return fail(answer.problem, number, () => void openNumber(number, back), back)
      const found = answer.value[0]
      // Not a work order of this site's bundles: Scan anything says what it is.
      if (!found) return store.openScan(number)
      feedback('success')
      await openOrder(found.id, back)
    },
    [api, fail, feedback, openOrder, store],
  )

  const openBundle = useCallback(
    async (code: string, back: Back) => {
      const key = codeKey(code)
      const card = { kind: 'bundle' as const, key, stage: 'card' as const, reason: null, busy: false, done: null, problem: null, writeKey: newIdempotencyKey(), back }
      if (!navigator.onLine) {
        if (CARDS.get(key)) return setScreen(card)
        return fail({ kind: 'offline' }, code, null, back)
      }
      setScreen({ kind: 'loading', code })
      const answer = await scanBundle(api, code)
      if (!answer.ok) {
        // A typo or another factory's code: Scan anything explains it.
        if (answer.problem.kind === 'invalid') return store.openScan(code)
        if (CARDS.get(key) && (answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable')) return setScreen(card)
        return fail(answer.problem, code, () => void openBundle(code, back), back)
      }
      CARDS.keep(key, answer.value)
      feedback(answer.value.refusal ? 'warning' : 'success')
      setScreen(card)
    },
    [api, fail, feedback, store],
  )

  const backOf = useCallback((): Back => (screen.kind === 'order' ? { kind: 'order', workOrderId: screen.workOrderId } : screen.kind === 'bundle' ? screen.back : { kind: 'pick' }), [screen])

  const onScan = useCallback(
    async (raw: string) => {
      if (!me) return
      const read = readScan(raw, me.scanTag)
      if (read.kind === 'badge') {
        const problem = await store.switchTo(read.code)
        if (problem) feedback('error')
        return
      }
      if (read.kind === 'label' && read.type === 'bundle') return openBundle(read.code, backOf())
      if ((read.kind === 'label' && read.type === 'workOrder') || read.kind === 'free') return openNumber(read.code, backOf())
      // A hide, a lot, another factory's label, a misread code: Scan anything shows its card or says why.
      store.openScan(raw)
    },
    [backOf, feedback, me, openBundle, openNumber, store],
  )

  // A code scanned on Home opens here with it; else the list.
  useEffect(() => {
    if (taken.current || !me) return
    taken.current = true
    if (!allowed) return
    const code = store.takeScan()
    if (code) void onScan(code)
    else void loadList()
  }, [allowed, loadList, me, onScan, store])

  // ---- the open work order: its proposal and the tickets made here ----

  const workOrderId = screen.kind === 'order' ? screen.workOrderId : null
  const remembered: Remembered<BundleOrder> | null = workOrderId ? ORDERS.get(workOrderId) : null
  const made = useMemo(() => (workOrderId ? MADE.filter((ticket) => ticket.workOrderId === workOrderId) : []), [workOrderId, queueSnapshot.items])
  const counted = (workOrderId && COUNTED.get(workOrderId)) || new Set<string>()

  // The office recorded a make this read does not count: read the work order again (its counts, its bundles' codes).
  const missing = uncounted(made, queueSnapshot.items, counted).join(',')
  useEffect(() => {
    if (!workOrderId || !online || missing === '') return
    void readOrder(workOrderId)
  }, [missing, online, readOrder, workOrderId])

  const printerOf = useCallback(
    (order: BundleOrder): PrinterModel => {
      const name = (id: string) => order.printers.find((printer) => printer.id === id)?.name ?? '—'
      if (order.printers.length === 0) return { kind: 'none' }
      if (order.stationPrinterId) return { kind: 'station', name: name(order.stationPrinterId) }
      if (order.defaultPrinterId) return { kind: 'site', name: name(order.defaultPrinterId) }
      return { kind: 'choose', printers: order.printers.map((printer) => ({ id: printer.id, name: printer.name })), picked: printers.get(order.workOrder.id) ?? null }
    },
    [printers],
  )

  const proposal = useMemo(() => {
    if (!remembered) return null
    const order = remembered.value
    const pending = pendingByCell(made, queueSnapshot.items, counted)
    const size = sizes.get(order.workOrder.id) ?? order.bundleSize
    const cells = order.cells
      .filter((cell) => cell.cut !== null)
      .map((cell) => {
        const own = pending.get(cell.workOrderSizeId) ?? 0
        const available = Math.max(0, cell.toBundle - own)
        const edited = overrides.get(cell.workOrderSizeId)
        const quantities = edited && edited.reduce((sum, value) => sum + value, 0) === available ? edited : proposalOf(available, size, order.singlePiece)
        return { id: cell.workOrderSizeId, label: cellLabel(cell), cut: cell.cut, bundled: cell.bundled, toBundle: available, pending: own, quantities, colourwayCode: cell.colourwayCode, size: cell.size }
      })
    return { order, size, cells }
  }, [counted, made, overrides, queueSnapshot.items, remembered, sizes])

  const contentOf = useCallback(
    (order: BundleOrder, cell: { colourwayCode: string; size: string }, quantity: number, code: string | null): TicketContent => ({
      code,
      workOrder: { number: order.workOrder.number, batchNumber: order.workOrder.batchNumber },
      style: { code: order.workOrder.style.code, name: order.workOrder.style.name },
      colourway: cell.colourwayCode,
      size: cell.size,
      quantity,
      part: null,
      operations: order.operations.map((operation) => ({ seq: operation.seq, code: operation.code, name: operation.name })),
    }),
    [],
  )

  const tickets: TicketModel[] = useMemo(() => {
    if (!remembered) return []
    const order = remembered.value
    const hasPrinter = order.printers.length > 0 ? ('some' as const) : ('none' as const)
    return [...made].reverse().flatMap((ticket) => {
      const view = queuedView(queueSnapshot, ticket.clientEventId)
      if (!view?.item) return []
      const item = view.item
      const bundleId = item.result?.type === 'Bundle' ? item.result.id : null
      const own = bundleId ? order.bundles.find((bundle) => bundle.id === bundleId) : undefined
      const jobsOf = bundleId ? (jobs.get(bundleId) ?? []) : []
      const code = item.numbered?.code ?? own?.code ?? jobOfCode(jobsOf, null)?.scanId ?? null
      const cell = order.cells.find((entry) => entry.workOrderSizeId === ticket.workOrderSizeId) ?? { colourwayCode: '', size: '' }
      const words = item.refusal ? (refusalWords(t, item.refusal.code) ?? { message: item.refusal.message, fix: item.refusal.fix }) : null
      return [
        {
          key: ticket.clientEventId,
          content: contentOf(order, cell, ticket.quantity, code),
          ticks: view.ticks,
          print: ticketPrint({ recorded: view.ticks === 'recorded', printer: hasPrinter, seesJobs, job: jobOfCode(jobsOf, code) }),
          refusal: view.ticks === 'refused' && words ? { message: words.message, fix: words.fix ?? '' } : null,
          retrying: retrying.has(ticket.clientEventId),
        },
      ]
    })
  }, [contentOf, jobs, made, queueSnapshot, remembered, retrying, seesJobs, t])

  // ---- print jobs: read while they move (queued, sent), for a while after the office recorded the bundle ----

  const reprinted = screen.kind === 'bundle' && screen.done?.kind === 'reprinted' ? screen.done : null
  const watched = useMemo(() => {
    const ids: string[] = []
    if (remembered && remembered.value.printers.length > 0) {
      for (const ticket of made) {
        const item = queueSnapshot.items.find((entry) => entry.clientEventId === ticket.clientEventId)
        if (item?.state === 'recorded' && item.result?.type === 'Bundle') ids.push(item.result.id)
      }
    }
    if (reprinted && !reprinted.printProblem) ids.push(reprinted.bundleId)
    return ids.filter((id) => {
      const job = jobOfCode(jobs.get(id) ?? [], null)
      const since = watchedSince.current.get(id) ?? Date.now()
      watchedSince.current.set(id, since)
      return jobMoving(job) && Date.now() - since < WATCH_MS
    })
  }, [jobs, made, queueSnapshot.items, remembered, reprinted])
  const watchKey = watched.join(',')

  useEffect(() => {
    if (!online || !seesJobs || watchKey === '') return
    let live = true
    const ids = watchKey.split(',')
    const read = async () => {
      for (const id of ids) {
        const answer = await fetchTicketJobs(api, id)
        if (!live) return
        if (answer.ok) setJobs((current) => new Map(current).set(id, answer.value))
      }
    }
    void read()
    const timer = window.setInterval(() => void read(), POLL_MS)
    return () => {
      live = false
      window.clearInterval(timer)
    }
  }, [api, online, seesJobs, watchKey])

  // ---- actions ----

  const make = useCallback(async () => {
    if (!proposal || making) return
    const { order, cells } = proposal
    const printer = printerOf(order)
    if (!order.workOrder.open || (printer.kind === 'choose' && printer.picked === null)) return
    const bundles = cells.flatMap((cell) => cell.quantities.map((quantity) => ({ cell, quantity })))
    if (bundles.length === 0) return
    // No label printer at the site: null (no job; said on screen). The station's or the site's only one: the office picks it.
    const printerId = printer.kind === 'none' ? { printerId: null } : printer.kind === 'choose' ? { printerId: printer.picked } : {}
    setMaking(true)
    try {
      for (const { cell, quantity } of bundles) {
        const item = await queue.enqueue('production.bundles.make', { workOrderId: order.workOrder.id, cells: [{ workOrderSizeId: cell.id, quantities: [quantity] }], ...printerId })
        MADE.push({ clientEventId: item.clientEventId, workOrderId: order.workOrder.id, workOrderSizeId: cell.id, quantity })
      }
      setOverrides((current) => {
        const next = new Map(current)
        for (const cell of cells) next.delete(cell.id)
        return next
      })
      feedback('success')
    } catch {
      fail({ kind: 'unavailable' }, null, null, { kind: 'order', workOrderId: order.workOrder.id })
    } finally {
      setMaking(false)
      bump()
    }
  }, [bump, fail, feedback, making, printerOf, proposal, queue])

  const retryPrint = useCallback(
    async (key: string) => {
      const bundleId = reprinted && key === reprinted.bundleId ? reprinted.bundleId : (() => {
        const item = queueSnapshot.items.find((entry) => entry.clientEventId === key)
        return item?.result?.type === 'Bundle' ? item.result.id : null
      })()
      if (!bundleId || !online) return
      const job = jobOfCode(jobs.get(bundleId) ?? [], null)
      if (!job || job.status !== 'FAILED') return
      setRetrying((current) => new Set(current).add(key))
      const answer = await retryJob(api, job, newIdempotencyKey())
      setRetrying((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
      if (!answer.ok) return void feedback('error')
      watchedSince.current.set(bundleId, Date.now())
      setJobs((current) => new Map(current).set(bundleId, [answer.value, ...(current.get(bundleId) ?? []).filter((entry) => entry.id !== answer.value.id)]))
      feedback('success')
    },
    [api, feedback, jobs, online, queueSnapshot.items, reprinted],
  )

  const card = screen.kind === 'bundle' ? CARDS.get(screen.key) : null

  const reprint = useCallback(
    async (reason: keyof typeof REPRINT_REASONS) => {
      if (screen.kind !== 'bundle' || !card || screen.busy || !online) return
      const current = screen
      setScreen({ ...current, busy: true })
      const answer = await reprintBundle(api, card.value.bundle.id, { reason: REPRINT_REASONS[reason] }, current.writeKey)
      if (!answer.ok) {
        if (answer.problem.kind === 'signedOut') return void store.sessionEnded()
        feedback('error')
        return setScreen({ ...current, stage: 'card', busy: false, problem: answer.problem })
      }
      const { ticket, replacedCode, bundle } = answer.value
      const newKey = codeKey(bundle.code)
      CARDS.keep(newKey, { ...card.value, scanned: bundle.code, refusal: null, bundle: { ...card.value.bundle, ...bundle, scans: card.value.bundle.scans }, ticket: ticket.ticket })
      if (ticket.job) setJobs((jobsNow) => new Map(jobsNow).set(bundle.id, [ticket.job!]))
      feedback('success')
      setScreen({
        ...current,
        key: newKey,
        stage: 'card',
        busy: false,
        problem: null,
        writeKey: newIdempotencyKey(),
        done: { kind: 'reprinted', replacedCode, bundleId: bundle.id, ticket: { ...ticket.ticket, colourway: ticket.ticket.colourway.code, operations: ticket.ticket.operations }, printProblem: ticket.problem },
      })
    },
    [api, card, feedback, online, screen, store],
  )

  const voidIt = useCallback(async () => {
    if (screen.kind !== 'bundle' || !card || screen.busy || !online || !screen.reason) return
    const current = screen
    setScreen({ ...current, busy: true })
    const answer = await voidBundle(api, card.value.bundle.id, VOID_REASONS[current.reason!], current.writeKey)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void store.sessionEnded()
      feedback('error')
      return setScreen({ ...current, stage: 'card', busy: false, reason: null, problem: answer.problem, writeKey: newIdempotencyKey() })
    }
    CARDS.keep(current.key, { ...card.value, bundle: { ...card.value.bundle, ...answer.value.bundle, scans: card.value.bundle.scans } })
    if (current.back.kind === 'order') ORDERS.forget(current.back.workOrderId)
    feedback('success')
    setScreen({ ...current, stage: 'card', busy: false, problem: null, done: { kind: 'voided', code: answer.value.bundle.code, quantity: answer.value.bundle.quantity } })
  }, [api, card, feedback, online, screen, store])

  const goBack = useCallback(() => {
    if (screen.kind === 'problem') {
      if (screen.back?.kind === 'order') return void openOrder(screen.back.workOrderId)
      return void loadList()
    }
    if (screen.kind === 'bundle') {
      if (screen.back.kind === 'order') return void openOrder(screen.back.workOrderId)
      return void loadList()
    }
    if (screen.kind === 'order') return void loadList()
    router.push('/floor')
  }, [loadList, openOrder, router, screen])

  const onAction = (action: BundlesAction) => {
    switch (action.type) {
      case 'scan':
        return void onScan(action.code)
      case 'open':
        return void openOrder(action.workOrderId, { kind: 'pick' })
      case 'back':
        return goBack()
      case 'home':
        return router.push('/floor')
      case 'reload':
        if (screen.kind === 'problem' && screen.again) return screen.again()
        return void loadList()
      case 'size':
        if (!proposal) return
        setOverrides(new Map())
        setEditing(null)
        return setSizes((current) => new Map(current).set(proposal.order.workOrder.id, nextBundleSize(proposal.size, action.step)))
      case 'edit':
        if (!proposal || proposal.order.singlePiece) return
        return setEditing({ workOrderId: proposal.order.workOrder.id, cellId: action.cellId, index: action.index, value: proposal.cells.find((cell) => cell.id === action.cellId)?.quantities[action.index] ?? null })
      case 'pad':
        return setEditing((current) => (current ? { ...current, value: action.value } : current))
      case 'padConfirm': {
        if (!proposal || !editing || editing.value === null) return
        const cell = proposal.cells.find((entry) => entry.id === editing.cellId)
        if (!cell) return setEditing(null)
        const max = maxAt(cell.quantities, editing.index, cell.toBundle)
        if (editing.value < 1 || editing.value > max) return
        setOverrides((current) => new Map(current).set(cell.id, editQuantity(cell.quantities, editing.index, editing.value!, cell.toBundle, proposal.size)))
        return setEditing(null)
      }
      case 'padCancel':
        return setEditing(null)
      case 'printer':
        if (!proposal) return
        return setPrinters((current) => new Map(current).set(proposal.order.workOrder.id, action.printerId))
      case 'make':
        return void make()
      case 'retryPrint':
        return void retryPrint(action.key)
      case 'reprint':
        if (screen.kind === 'bundle' && online) setScreen({ ...screen, stage: 'reprint', problem: null, done: null })
        return
      case 'reprintReason':
        return void reprint(action.reason)
      case 'void':
        if (screen.kind === 'bundle' && online) setScreen({ ...screen, stage: 'void', reason: null, problem: null, done: null })
        return
      case 'voidReason':
        if (screen.kind === 'bundle') setScreen({ ...screen, reason: action.reason })
        return
      case 'voidConfirm':
        return void voidIt()
      case 'cancel':
        if (screen.kind === 'bundle') setScreen({ ...screen, stage: 'card', reason: null, busy: false })
        return
    }
  }

  // ---- the view's model ----

  let step: BundlesStep
  if (!allowed) step = { kind: 'noPermission' }
  else if (screen.kind === 'loading') step = { kind: 'loading', code: screen.code }
  else if (screen.kind === 'problem') step = { kind: 'problem', problem: screen.problem, code: screen.code }
  else if (screen.kind === 'pick') {
    const list = LIST.get('all')
    step = {
      kind: 'pick',
      rows: (list?.value ?? [])
        .filter((row) => row.toBundle > 0)
        .map((row) => ({ id: row.id, number: row.number, batchNumber: row.batchNumber, style: row.style.name || row.style.code, toBundle: row.toBundle, cells: row.cells.map((cell) => ({ label: cellLabel(cell), cut: cell.cut, bundled: cell.bundled, toBundle: cell.toBundle })) })),
      asOf: list?.asOf ?? null,
    }
  } else if (screen.kind === 'order' && proposal) {
    const { order, size, cells } = proposal
    const edited = editing && editing.workOrderId === order.workOrder.id ? editing : null
    const editedCell = edited ? cells.find((cell) => cell.id === edited.cellId) : undefined
    step = {
      kind: 'proposal',
      order: { id: order.workOrder.id, number: order.workOrder.number, batchNumber: order.workOrder.batchNumber, style: [order.workOrder.style.code, order.workOrder.style.name].filter(Boolean).join(' · '), open: order.workOrder.open },
      cells,
      bundleSize: size,
      standardBundleSize: order.standardBundleSize,
      singlePiece: order.singlePiece,
      printer: printerOf(order),
      seesJobs,
      editing: edited && editedCell ? { cellId: edited.cellId, index: edited.index, value: edited.value, max: maxAt(editedCell.quantities, edited.index, editedCell.toBundle) } : null,
      tickets,
      making,
      asOf: remembered?.asOf ?? null,
    }
  } else if (screen.kind === 'bundle' && card) {
    const value = card.value
    const model: CardModel = {
      id: value.bundle.id,
      code: value.bundle.code,
      scanned: value.scanned,
      status: value.bundle.status,
      refusal: value.refusal,
      workOrder: { number: value.workOrder.number, batchNumber: value.workOrder.batchNumber, style: [value.workOrder.style.code, value.workOrder.style.name].filter(Boolean).join(' · ') },
      colourway: [value.ticket.colourway.code, value.ticket.colourway.name].filter(Boolean).join(' '),
      size: value.bundle.size,
      part: value.bundle.part,
      quantity: value.bundle.quantity,
      scans: value.bundle.scans,
      operations: value.operations.map((operation) => ({ seq: operation.seq, code: operation.code, name: operation.name, done: operation.done })),
      replacedCodes: value.bundle.replacedCodes,
      ticket: { ...value.ticket, colourway: value.ticket.colourway.code },
    }
    let done: BundleDone | null = null
    if (screen.done?.kind === 'voided') done = screen.done
    else if (screen.done?.kind === 'reprinted') {
      const printed = screen.done
      const job = jobOfCode(jobs.get(printed.bundleId) ?? [], printed.ticket.code)
      done = {
        kind: 'reprinted',
        replacedCode: printed.replacedCode,
        ticket: {
          key: printed.bundleId,
          content: printed.ticket,
          ticks: 'recorded',
          print: printed.printProblem ? { kind: 'none' } : ticketPrint({ recorded: true, printer: 'some', seesJobs, job }),
          retrying: retrying.has(printed.bundleId),
        },
      }
    }
    step = { kind: 'bundle', card: model, stage: screen.stage, reason: screen.reason, busy: screen.busy, done, problem: screen.problem, asOf: card.asOf }
  } else step = { kind: 'loading', code: null }

  const low = store.shellQueue.lowNumbers.find((entry) => entry.kind === 'BUNDLE')

  useFloorKeys({
    enter:
      step.kind === 'proposal'
        ? step.editing
          ? () => onAction({ type: 'padConfirm' })
          : () => onAction({ type: 'make' })
        : step.kind === 'bundle' && step.stage === 'card' && !step.done && step.card.status === 'ACTIVE' && online
          ? () => onAction({ type: 'reprint' })
          : null,
    escape: step.kind === 'proposal' && step.editing ? () => onAction({ type: 'padCancel' }) : step.kind === 'bundle' && step.stage === 'reprint' ? () => onAction({ type: 'cancel' }) : goBack,
  })

  if (!me) return null
  return <BundlesView model={{ frame, online, step, lowNumbers: low ? low.left : null }} onFrame={onFrame} onAction={onAction} camera={zxingCamera} />
}
