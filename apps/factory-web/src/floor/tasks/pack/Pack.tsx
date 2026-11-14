'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLiveChanges } from '../../../record-panels/live'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { onlineFirst, type OnlineFirst } from '../../queue/online-first'
import type { QueueItem } from '../../queue/model'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory } from '../shared/as-of'
import type { TaskOutcome, TaskProblem } from '../shared/task-api'
import { listPacking, markPacked, markUnpacked, printDocuments, printLabels, readJob, readLabels, readPacking, removeParcel, retryJob, type JobStatus, type Labels, type Packing, type PackingRow } from './api'
import { closeCarton, marksPdf, printMarks, readBench, scanInto, takeOut, type Bench, type ScanAnswer, type TakeOutAnswer } from './carton/api'
import {
  benchLeft,
  benchMain,
  cartonOfMarks,
  cartonsOf,
  cellsOfBatch,
  closeChoice,
  closeHeld,
  currentCartonOf,
  gridCellOf,
  cellName,
  holdReasonOf,
  inFlash,
  keptScans,
  marksFacts,
  overweight,
  packGrid,
  problemRefusal,
  settledSince,
  cartonMarkCode,
  type CloseChoice,
  type FlashBody,
  type MarksNote,
  type ScanFlash,
} from './carton/model'
import { printPdf } from './carton/print-pdf'
import { packedSummary, type PackedSummary } from './done/model'
import { carrierOf, documentsState, headOf, jobMoving, readyRows, scanTarget, unpackHeld, weightText } from './model'
import { PackView, type BenchStep, type JobModel, type PackAction, type PackRowModel, type PackStep } from './view/PackView'

/**
 * The live SCR-098 (`/floor/pack`): the packing bench. It reads the site's shipments to pack (`GET /shipping/packing`), one
 * shipment as a packer sees it (`GET /shipping/packing/:id`) with its bench (B-W2b-384's `GET …/cartons`: the size grid,
 * the cartons, the open carton, the packaging, the hold, what is left) and, once packed, its carrier labels. B-W2b-387:
 * each garment scanned goes in with ONE call (`POST …/scan`), or stays on the tablet's queue under the same client id when
 * the network is gone (floor-sync `shipping.carton.scan`: the office puts it into the open carton when it arrives); a wrong
 * piece flashes with its reason; a batch label that names no size lets the packer tap the size on the grid; a garment is
 * taken out of a carton; Close carton (packaging and weight) stores its contents and prints its marks — or says why not and
 * offers them again or as a PDF made here; Packed; then the labels and the DDT on the station's printers, and Packed's
 * summary. Live: the bench reads again on the shipment's events and every 30 s while in view. Each write carries the
 * shipment's version as read where the route takes one; a conflict reads it again.
 */

interface Loaded {
  readonly packing: Packing
  readonly bench: Bench | null
  readonly labels: Labels | null
}

interface Job extends JobModel {
  readonly version: number | null
}

type Stage = { kind: 'list' } | { kind: 'pack' } | { kind: 'documents' } | { kind: 'done'; summary: PackedSummary }

const memory = new AsOfMemory<Loaded>(20)
const listMemory = new AsOfMemory<PackingRow[]>(1)
const POLL_MS = 3_000
/** While the office has not issued the DDT or bought the labels: read the shipment again now and then. */
const WAIT_MS = 10_000
/** The events that change the bench (their floor rules: shipping.pack, print.view, floor.work). */
const LIVE = new Set(['shipment.packing_changed', 'shipping.carton_packed', 'shipment.status_changed', 'shipment.labels_bought', 'shipment.label_voided', 'print.job_changed', 'quality.hold_placed', 'quality.hold_released'])
/** Several events of one change arrive together: one read after a short pause. */
const LIVE_PAUSE_MS = 1_500
/** A missed live hint: the bench reads again this often while in view. */
const BEAT_MS = 30_000
/** Refusals that say the bench on screen is out of date. */
const STALE: ReadonlySet<string> = new Set(['ON_HOLD', 'QUALITY_HOLD', 'NOT_DRAFT', 'CARTON_CLOSED', 'CARTON_LABELLED'])

export function FloorPack() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.pack', { showHome: true })
  const { api, me, online, sessionEnded, queue } = store
  const deviceId = store.device?.device.id ?? null
  const permissions = useMemo(() => new Set(me?.permissions ?? []), [me?.permissions])
  const can = { pack: permissions.has('shipping.pack'), printLabels: permissions.has('print.labels') }

  const [stage, setStage] = useState<Stage>({ kind: 'list' })
  const [rows, setRows] = useState<PackingRow[] | null>(null)
  const [scanned, setScanned] = useState<{ code: string; why: 'notFound' | 'serialFirst' } | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const current = useRef<Loaded | null>(null)
  current.current = loaded
  const [flash, setFlash] = useState<ScanFlash | null>(null)
  const flashes = useRef(0)
  const [outOf, setOutOf] = useState<string | null>(null)
  const [choosing, setChoosing] = useState<{ code: string; cellIds: readonly string[]; out: string | null } | null>(null)
  const [close, setClose] = useState<CloseChoice | null>(null)
  const [marks, setMarks] = useState<{ note: MarksNote; job: { id: string; status: JobStatus; version: number | null } | null } | null>(null)
  const [pdf, setPdf] = useState<{ bytes: Uint8Array; number: string } | 'loading' | null>(null)
  /** The cartons whose marks were just sent to the printer again (Print the marks again). */
  const [printedMarks, setPrintedMarks] = useState<readonly number[] | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ problem: TaskProblem; code?: string | null } | null>(null)
  const [notice, setNotice] = useState<TaskProblem | null>(null)
  const [busy, setBusy] = useState(false)
  const taken = useRef(false)

  const ended = (outcome: { ok: false; problem: TaskProblem }) => {
    if (outcome.problem.kind === 'signedOut') void sessionEnded()
  }
  const nextFlash = (made: FlashBody): ScanFlash => ({ ...made, seq: ++flashes.current })

  const keep = useCallback((next: Loaded) => {
    memory.keep(next.packing.id, next)
    current.current = next
    setLoaded(next)
  }, [])

  /** The bench as an answer gave it (the packing's version follows the shipment's). */
  const keepBench = useCallback(
    (bench: Bench) => {
      const now = current.current
      if (!now || now.packing.id !== bench.shipment.id) return
      keep({ ...now, bench, packing: { ...now.packing, version: bench.shipment.version } })
    },
    [keep],
  )

  // ---- reads ------------------------------------------------------------------------------------------------------------

  const loadList = useCallback(async () => {
    const answer = await listPacking(api)
    if (answer.ok) {
      const ready = readyRows(answer.value.shipments)
      listMemory.keep('rows', ready)
      setRows(ready)
      setAsOf(null)
      return
    }
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    const kept = listMemory.get('rows')
    if (kept && (answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable')) {
      setRows(kept.value)
      setAsOf(kept.asOf)
      return
    }
    setProblem({ problem: answer.problem })
  }, [api, sessionEnded])

  const loadShipment = useCallback(
    async (id: string, code?: string | null, quiet = false): Promise<Loaded | null> => {
      const [answer, bench] = await Promise.all([readPacking(api, id), readBench(api, id)])
      if (!answer.ok) {
        if (answer.problem.kind === 'signedOut') {
          void sessionEnded()
          return null
        }
        const kept = memory.get(id)
        if (kept && (answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable')) {
          current.current = kept.value
          setLoaded(kept.value)
          setAsOf(kept.asOf)
          return kept.value
        }
        if (!quiet) setProblem({ problem: answer.problem, code: code ?? null })
        return null
      }
      const packing = answer.value.shipment
      const labels = packing.status === 'DRAFT' ? null : await readLabels(api, id)
      const before = current.current?.packing.id === id ? current.current : null
      const next: Loaded = { packing, bench: bench.ok ? bench.value : (before?.bench ?? null), labels: labels?.ok ? labels.value : (before?.labels ?? null) }
      if (!bench.ok && !next.bench) {
        if (bench.problem.kind === 'signedOut') {
          void sessionEnded()
          return null
        }
        if (!quiet) setProblem({ problem: bench.problem, code: code ?? null })
        return null
      }
      keep(next)
      setAsOf(null)
      return next
    },
    [api, sessionEnded, keep],
  )

  const enterDocuments = useCallback((value: Loaded) => {
    const seeded: Job[] = (value.labels?.parcels ?? []).flatMap((parcel) => (parcel.print ? [{ id: parcel.print.jobId, what: 'LABEL' as const, seq: parcel.seq, status: statusOf(parcel.print.status), detail: null, version: null }] : []))
    setJobs(seeded)
    setStage({ kind: 'documents' })
  }, [])

  const resetBench = () => {
    setFlash(null)
    setOutOf(null)
    setChoosing(null)
    setClose(null)
    setMarks(null)
    setPdf(null)
  }

  const open = useCallback(
    async (id: string, code?: string | null) => {
      setScanned(null)
      setProblem(null)
      setNotice(null)
      resetBench()
      setBusy(true)
      const next = await loadShipment(id, code)
      setBusy(false)
      if (!next) return
      if (next.packing.status === 'DRAFT') return setStage({ kind: 'pack' })
      enterDocuments(next)
    },
    [loadShipment, enterDocuments],
  )

  // ---- writes -------------------------------------------------------------------------------------------------------------

  /** A refused write's answer: said on the step (a conflict reads the shipment again first). */
  const refusedWrite = useCallback(
    async (outcome: { ok: false; problem: TaskProblem }) => {
      ended(outcome)
      feedback('error')
      if (outcome.problem.kind === 'conflict' && current.current) await loadShipment(current.current.packing.id, null, true)
      setNotice(outcome.problem)
    },
    [feedback, loadShipment],
  )

  /** One garment into the carton (`cellId`: the size tapped on the grid): online, or kept on the tablet under the same id. */
  const scanIn = async (code: string, cellId?: string) => {
    const now = current.current
    if (!now) return
    const shipmentId = now.packing.id
    const body = { code, ...(cellId ? { cellId } : {}) }
    setBusy(true)
    setNotice(null)
    let result: OnlineFirst<TaskOutcome<ScanAnswer>>
    try {
      result = await onlineFirst(queue, { online, kind: 'shipping.carton.scan', payload: { shipmentId, ...body }, attempt: (id) => scanInto(api, shipmentId, body, stepKey(deviceId, id)) })
    } catch {
      // Not kept: the tablet holds no one signed in to keep it for (the frame sends them to sign in).
      setBusy(false)
      feedback('error')
      return setNotice({ kind: 'offline' })
    }
    setBusy(false)
    if (result.kept) {
      feedback('success')
      return setFlash(nextFlash({ code, kind: 'kept' }))
    }
    const answer = result.answer
    if (answer.ok) {
      keepBench(answer.value.bench)
      feedback('success')
      return setFlash(inFlash(++flashes.current, code, packGrid(answer.value.bench), answer.value.scan))
    }
    refusedScan(code, answer, null)
  }

  /** One garment out of the carton picked (online only: what comes out must be known at once). */
  const scanOut = async (code: string, parcelId: string, cellId?: string) => {
    const now = current.current
    if (!now) return
    if (!online) {
      feedback('warning')
      return setFlash(nextFlash({ code, kind: 'needsNetwork' }))
    }
    setBusy(true)
    setNotice(null)
    const answer: TaskOutcome<TakeOutAnswer> = await takeOut(api, now.packing.id, parcelId, { code, ...(cellId ? { cellId } : {}) }, stepKey(deviceId, newIdempotencyKey()))
    setBusy(false)
    if (answer.ok) {
      keepBench(answer.value.bench)
      setOutOf(null)
      feedback('success')
      const found = gridCellOf(packGrid(answer.value.bench), answer.value.takenOut.cellId)
      return setFlash(nextFlash({ code, kind: 'out', cell: found ? cellName(found.row, found.cell.size) : '', carton: answer.value.takenOut.cartonSeq, reopened: answer.value.takenOut.reopened }))
    }
    refusedScan(code, answer, parcelId)
  }

  /** A scan the office refused: its reason big; a batch label without a size: its sizes on the grid to tap. */
  const refusedScan = (code: string, answer: { ok: false; problem: TaskProblem }, out: string | null) => {
    ended(answer)
    const refusal = problemRefusal(answer.problem)
    const now = current.current
    if (refusal === 'SIZE_NEEDED' && now?.bench) {
      const cellIds = cellsOfBatch(code, packGrid(now.bench), now.packing.lines)
      feedback('warning')
      setChoosing(cellIds.length > 0 ? { code, cellIds, out } : null)
      return setFlash(nextFlash({ code, kind: 'chooseSize', cellIds }))
    }
    feedback('error')
    if (answer.problem.kind === 'refused' || answer.problem.kind === 'conflict') {
      // The shipment changed under the bench (a version, a hold, packed or labelled elsewhere): read it again.
      if (now && (answer.problem.kind === 'conflict' || (refusal !== null && STALE.has(refusal)))) void loadShipment(now.packing.id, null, true)
      return setFlash(nextFlash({ code, kind: 'refused', refusal }))
    }
    setNotice(answer.problem)
  }

  // A plain function (not memoised): it reads this render's state.
  const onScan = async (code: string, fromHome: boolean) => {
    if (!me) return
    const read = readScan(code, me.scanTag)
    if (read.kind === 'badge') {
      if (await store.switchTo(read.code)) feedback('error')
      return
    }
    const now = stage.kind === 'pack' ? current.current : null
    const target = scanTarget(read, now !== null, rows ?? listMemory.get('rows')?.value ?? [])
    if (target.kind === 'shipment' && target.row.id !== now?.packing.id) {
      feedback('success')
      return void open(target.row.id, target.row.number)
    }
    if (!now) {
      // On the list: a code that is no shipment of this station. From Home, it is handed on to Scan anything (a work
      // order's traveller, a hide …); a garment's serial waits for its shipment's pack slip.
      const serial = read.kind === 'label' && read.type === 'serial'
      if (fromHome && !serial) return store.openScan(code)
      feedback('error')
      return setScanned({ code: read.code, why: serial ? 'serialFirst' : 'notFound' })
    }
    setChoosing(null)
    // Its own carton's marks (or its pack slip again): no garment.
    const cartons = now.bench ? cartonsOf(now.bench) : []
    const own = target.kind === 'shipment' ? (target.carton !== null ? (cartons.find((carton) => carton.seq === target.carton) ?? null) : null) : cartonOfMarks(read.code, now.packing.number, cartons)
    if (own || target.kind === 'shipment') {
      feedback('warning')
      return own ? setFlash(nextFlash({ code: read.code, kind: 'cartonLabel', carton: own.seq })) : undefined
    }
    if (target.kind === 'unknown') {
      feedback('error')
      return setFlash(nextFlash({ code: read.code, kind: 'refused', refusal: 'UNKNOWN_CODE' }))
    }
    if (now.bench?.hold) {
      feedback('error')
      return setFlash(nextFlash({ code: read.code, kind: 'refused', refusal: 'ON_HOLD' }))
    }
    if (outOf) return void scanOut(read.code, outOf)
    return void scanIn(read.code)
  }
  const scanRef = useRef(onScan)
  scanRef.current = onScan

  // On arrival: the list, and the code Home's scan router handed over (a pack slip, a carton's marks, a garment's label).
  useEffect(() => {
    if (taken.current || !me) return
    taken.current = true
    if (!can.pack) return
    void loadList().then(() => {
      const code = store.takeScan()
      if (code) void scanRef.current(code, true)
    })
  }, [me, can.pack, loadList, store])

  // ---- live: the bench reads again on its shipment's events, after a queued scan settles, and every 30 s in view ---------------

  const liveTimer = useRef<number | null>(null)
  const refreshNow = useCallback(async () => {
    const now = current.current
    if (!now || busy) return
    if (stage.kind === 'pack' || stage.kind === 'documents') {
      const next = await loadShipment(now.packing.id, null, true)
      if (next && stage.kind === 'pack' && next.packing.status !== 'DRAFT') enterDocuments(next)
    } else if (stage.kind === 'list') void loadList()
  }, [busy, stage.kind, loadShipment, loadList, enterDocuments])
  const soon = useCallback(() => {
    if (liveTimer.current !== null) return
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = null
      void refreshNow()
    }, LIVE_PAUSE_MS)
  }, [refreshNow])
  useEffect(
    () => () => {
      if (liveTimer.current !== null) window.clearTimeout(liveTimer.current)
    },
    [],
  )
  useLiveChanges({ onChange: (change) => (LIVE.has(change.type) ? soon() : undefined), onReconnect: soon }, Boolean(me) && online && can.pack)
  useEffect(() => {
    if (!me || !online || !can.pack) return
    const beat = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !close) void refreshNow()
    }, BEAT_MS)
    return () => window.clearInterval(beat)
  }, [me, online, can.pack, close, refreshNow])
  // A kept scan of this shipment recorded (or refused) by the queue: the grid counts it now.
  const items = store.queueSnapshot.items
  const lastItems = useRef<readonly QueueItem[]>(items)
  useEffect(() => {
    const before = lastItems.current
    lastItems.current = items
    const now = current.current
    if (now && stage.kind === 'pack' && settledSince(before, items, now.packing.id)) soon()
  }, [items, stage.kind, soon])

  // Print jobs move queued → sent → printed or failed: read them again while one is on its way (the labels, the DDT, the marks).
  useEffect(() => {
    if (stage.kind !== 'documents' || !online || !jobs.some((job) => jobMoving(job.status))) return
    const timer = window.setTimeout(async () => {
      const next = await Promise.all(
        jobs.map(async (job) => {
          if (!jobMoving(job.status)) return job
          const answer = await readJob(api, job.id)
          return answer.ok ? { ...job, status: answer.value.job.status, detail: answer.value.job.lastError, version: answer.value.job.version } : job
        }),
      )
      setJobs(next)
    }, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [stage.kind, jobs, online, api])
  useEffect(() => {
    const job = marks?.job
    if (!job || !online || !jobMoving(job.status)) return
    const timer = window.setTimeout(async () => {
      const answer = await readJob(api, job.id)
      if (answer.ok) setMarks((before) => (before?.job?.id === job.id ? { ...before, job: { id: job.id, status: answer.value.job.status, version: answer.value.job.version } } : before))
    }, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [marks, online, api])

  // Packed, waiting for the office (the DDT, the labels): read the shipment again now and then.
  const waiting = loaded && stage.kind === 'documents' ? documentsState(loaded.packing, loaded.labels, { printLabels: can.printLabels }) : null
  const officeWait = waiting !== null && (waiting.documents.held === 'officeIssues' || waiting.labels.held === 'officeBuys')
  useEffect(() => {
    if (!officeWait || !online || !loaded) return
    const timer = window.setTimeout(() => void loadShipment(loaded.packing.id, null, true), WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [officeWait, online, loaded, loadShipment])

  // ---- the actions ------------------------------------------------------------------------------------------------------

  const toList = () => {
    setLoaded(null)
    current.current = null
    resetBench()
    setJobs([])
    setStage({ kind: 'list' })
    void loadList()
  }

  const back = () => {
    setNotice(null)
    setProblem(null)
    if (pdf) return setPdf(null)
    if (close) return setClose(null)
    if (choosing) {
      setChoosing(null)
      return setFlash(null)
    }
    if (outOf) return setOutOf(null)
    if (stage.kind === 'list') return router.push('/floor')
    toList()
  }

  const print = async () => {
    const value = current.current
    if (!value || !online) return
    const state = documentsState(value.packing, value.labels, { printLabels: can.printLabels })
    setBusy(true)
    setNotice(null)
    const made: Job[] = []
    if (state.labels.held === null) {
      const answer = await printLabels(api, value.packing.id)
      if (answer.ok) made.push(...answer.value.jobs.map((job) => ({ id: job.jobId, what: 'LABEL' as const, seq: job.seq, status: statusOf(job.status), detail: null, version: null })))
      else {
        ended(answer)
        setNotice(answer.problem)
      }
    }
    if (state.documents.held === null) {
      const answer = await printDocuments(api, value.packing.id)
      if (answer.ok) made.push(...answer.value.jobs.map((job) => ({ id: job.jobId, what: job.document, seq: null, status: statusOf(job.status), detail: null, version: null })))
      else {
        ended(answer)
        setNotice(answer.problem)
      }
    }
    setBusy(false)
    feedback(made.length > 0 ? 'success' : 'error')
    if (made.length > 0) setJobs((known) => [...known.filter((job) => !made.some((entry) => entry.what === job.what && entry.seq === job.seq)), ...made])
  }

  /** The marks of the cartons whose marks are due (or those named) on the station's label printer. */
  const marksAgain = async (parcelIds: readonly string[] | null) => {
    const now = current.current
    if (!now || !online) return
    setBusy(true)
    setNotice(null)
    const answer = await printMarks(api, now.packing.id, parcelIds, stepKey(deviceId, newIdempotencyKey()))
    setBusy(false)
    if (!answer.ok) return void (await refusedWrite(answer))
    feedback('success')
    const next = await loadShipment(now.packing.id, null, true)
    const jobOf = marks ? answer.value.jobs.find((job) => job.parcelId === marks.note.cartonId) : undefined
    if (marks && jobOf) setMarks({ note: { ...marks.note, printed: true, problem: null }, job: { id: jobOf.jobId, status: 'QUEUED', version: null } })
    else if (next?.bench) {
      const printed = answer.value.jobs.map((job) => next.bench!.cartons.find((carton) => carton.id === job.parcelId)?.seq).filter((seq): seq is number => seq !== undefined)
      setFlash(null)
      setMarks(null)
      setNotice(null)
      if (printed.length > 0) setPrintedMarks(printed)
    }
  }
  const openPdf = async (parcelIds: readonly string[]) => {
    const now = current.current
    if (!now || !online || parcelIds.length === 0) return
    setPdf('loading')
    const answer = await marksPdf(api, now.packing.id, parcelIds, stepKey(deviceId, newIdempotencyKey()))
    if (!answer.ok) {
      setPdf(null)
      return void (await refusedWrite(answer))
    }
    setPdf({ bytes: answer.value, number: now.packing.number })
    if (marks && parcelIds.includes(marks.note.cartonId)) setMarks({ ...marks, note: { ...marks.note, printed: true, problem: null } })
    void loadShipment(now.packing.id, null, true)
  }

  const onAction = async (action: PackAction) => {
    const value = current.current
    const packing = value?.packing ?? null
    const bench = value?.bench ?? null
    switch (action.type) {
      case 'scan':
        return onScan(action.code, false)
      case 'open':
        return open(action.id)
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'retry':
        setProblem(null)
        if (packing && stage.kind !== 'list') return void open(packing.id)
        return void loadList()
      case 'next':
        return toList()
      case 'choose-cell': {
        if (!choosing) return
        const { code, out } = choosing
        setChoosing(null)
        if (out) return void scanOut(code, out, action.cellId)
        return void scanIn(code, action.cellId)
      }
      case 'take-out':
        setChoosing(null)
        setFlash(null)
        return setOutOf((before) => (before === action.cartonId ? null : action.cartonId))
      case 'remove-carton': {
        if (!packing || !online) return
        setBusy(true)
        setNotice(null)
        const answer = await removeParcel(api, packing.id, action.id, bench?.shipment.version ?? packing.version)
        setBusy(false)
        if (!answer.ok) return void (await refusedWrite(answer))
        if (outOf === action.id) setOutOf(null)
        feedback('success')
        return void loadShipment(packing.id, null, true)
      }
      case 'close-carton': {
        if (!bench) return
        const carton = cartonsOf(bench).find((entry) => entry.id === action.cartonId)
        if (!carton || carton.garments === 0) return
        setOutOf(null)
        setChoosing(null)
        return setClose(closeChoice(carton, bench))
      }
      case 'close-packaging':
        return close ? setClose({ ...close, packagingId: action.id }) : undefined
      case 'close-weight':
        return close ? setClose({ ...close, weight: action.value }) : undefined
      case 'close-confirm': {
        if (!packing || !bench || !close || !online || busy) return
        if (closeHeld(close, bench.packagingTypes)) return void feedback('warning')
        const weight = close.weight === null ? null : weightText(close.weight)
        if (!weight || !close.packagingId) return void feedback('warning')
        setBusy(true)
        setNotice(null)
        const answer = await closeCarton(api, packing.id, close.cartonId, { version: bench.shipment.version, packagingTypeId: close.packagingId, grossWeightKg: weight }, stepKey(deviceId, newIdempotencyKey()))
        setBusy(false)
        if (!answer.ok) return void (await refusedWrite(answer))
        keepBench(answer.value.bench)
        const { closed, marks: printed } = answer.value
        feedback(printed.printed ? 'success' : 'warning')
        setClose(null)
        setFlash(null)
        setPrintedMarks(null)
        return setMarks({
          note: { cartonId: closed.parcelId, seq: closed.cartonNumber, n: closed.cartonNumber, of: closed.cartonCount, printed: printed.printed, jobIds: printed.jobIds, problem: printed.problem?.code ?? null, overweight: closed.warnings.includes('OVERWEIGHT') },
          job: printed.jobIds[0] ? { id: printed.jobIds[0], status: 'QUEUED', version: null } : null,
        })
      }
      case 'close-cancel':
        return setClose(null)
      case 'marks-print':
        return marksAgain(action.parcelIds ?? null)
      case 'marks-retry': {
        const job = marks?.job
        if (!job || !online) return
        let version = job.version
        if (version === null) {
          const read = await readJob(api, job.id)
          if (!read.ok) return setNotice(read.problem)
          version = read.value.job.version
        }
        const answer = await retryJob(api, { id: job.id, version })
        if (!answer.ok) {
          ended(answer)
          return setNotice(answer.problem)
        }
        return setMarks((before) => (before ? { ...before, job: { id: job.id, status: answer.value.job.status, version: answer.value.job.version } } : before))
      }
      case 'marks-pdf':
        return openPdf(action.parcelIds)
      case 'pdf-print':
        return pdf && pdf !== 'loading' ? printPdf(pdf.bytes) : undefined
      case 'pdf-close':
        return setPdf(null)
      case 'packed': {
        if (!packing || !online) return
        setBusy(true)
        setNotice(null)
        const answer = await markPacked(api, packing.id, bench?.shipment.version ?? packing.version)
        if (!answer.ok) {
          setBusy(false)
          return void (await refusedWrite(answer))
        }
        const next = await loadShipment(answer.value.shipment.id)
        setBusy(false)
        feedback('success')
        resetBench()
        if (next) enterDocuments(next)
        return
      }
      case 'unpack': {
        if (!packing || !online) return
        setBusy(true)
        setNotice(null)
        const answer = await markUnpacked(api, packing.id, packing.version)
        setBusy(false)
        if (!answer.ok) return void (await refusedWrite(answer))
        setJobs([])
        await loadShipment(packing.id, null, true)
        return setStage({ kind: 'pack' })
      }
      case 'documents':
        if (!value) return
        return enterDocuments(value)
      case 'print':
        return print()
      case 'retry-job': {
        const job = jobs.find((entry) => entry.id === action.jobId)
        if (!job || !online) return
        let version = job.version
        if (version === null) {
          const read = await readJob(api, job.id)
          if (!read.ok) return setNotice(read.problem)
          version = read.value.job.version
        }
        const answer = await retryJob(api, { id: job.id, version })
        if (!answer.ok) {
          ended(answer)
          return setNotice(answer.problem)
        }
        return setJobs((known) => known.map((entry) => (entry.id === job.id ? { ...entry, status: answer.value.job.status, detail: answer.value.job.lastError, version: answer.value.job.version } : entry)))
      }
      case 'finish': {
        if (!value) return
        const cartons = value.bench ? cartonsOf(value.bench) : []
        return setStage({
          kind: 'done',
          summary: packedSummary({
            number: value.packing.number,
            cartons: value.bench ? cartons.length : value.packing.parcels.length,
            marksDue: cartons.some((carton) => carton.marks === 'due'),
            transportBy: value.packing.transportBy,
            documents: documentsState(value.packing, value.labels, { printLabels: can.printLabels }),
            jobs: jobs.map((job) => ({ what: job.what, status: job.status })),
          }),
        })
      }
    }
  }

  // ---- the step's model, and the keys: Enter = the main action, Esc = back -------------------------------------------------

  const benchStep = loaded && loaded.bench && stage.kind === 'pack' ? benchModel(loaded, { flash, outOf, choosing, close, marks, pdf, printedMarks }, store.queueSnapshot.items) : null

  const enter = (): PackAction | null => {
    if (busy) return null
    switch (stage.kind) {
      case 'pack': {
        if (!benchStep) return null
        if (pdf) return null
        if (close) return { type: 'close-confirm' }
        if (benchStep.hold || !online) return null
        const main = benchStep.main
        if (main.kind === 'close') return { type: 'close-carton', cartonId: main.carton.id }
        if (main.kind === 'marks') return { type: 'marks-print' }
        if (main.kind === 'packed') return { type: 'packed' }
        return null
      }
      case 'documents':
        return jobs.length > 0 || !waiting?.printable ? { type: 'finish' } : { type: 'print' }
      case 'done':
        return { type: 'next' }
      default:
        return null
    }
  }
  useFloorKeys({ enter: () => void ((action) => action && onAction(action))(enter()), escape: () => back() })

  if (!me) return null

  const head = loaded ? headOf(loaded.packing, loaded.bench?.cartons.length) : null
  const step: PackStep = !can.pack
    ? { kind: 'noPermission' }
    : problem
      ? { kind: 'problem', problem: problem.problem, code: problem.code ?? null }
      : stage.kind === 'done'
        ? { kind: 'done', summary: stage.summary }
        : stage.kind === 'list' || !loaded || !head
          ? rows === null
            ? { kind: 'loading' }
            : { kind: 'list', rows: rows.map(rowModel), scanned }
          : stage.kind === 'pack'
            ? benchStep
              ? { kind: 'pack', head, bench: benchStep }
              : { kind: 'loading', code: loaded.packing.number }
            : { kind: 'documents', head, documents: documentsModel(loaded, jobs, can.printLabels), unpackHeld: unpackHeld(loaded.packing) }

  return (
    <PackView
      model={{ frame, online, can: { pack: can.pack, printLabels: can.printLabels }, step, asOf, busy, notice }}
      onFrame={onFrame}
      onAction={(action) => void onAction(action)}
      camera={zxingCamera}
    />
  )
}

// ---- API → view model ------------------------------------------------------------------------------------------------------

/** The floor's step key of an action (`<device>.<client event id>`, as the queue sends it). */
const stepKey = (deviceId: string | null, clientEventId: string): string => (deviceId ? `${deviceId}.${clientEventId}` : clientEventId)

const JOB_STATUSES: readonly JobStatus[] = ['QUEUED', 'SENT', 'PRINTED', 'FAILED']
const statusOf = (status: string): JobStatus => (JOB_STATUSES.includes(status as JobStatus) ? (status as JobStatus) : 'QUEUED')

const rowModel = (row: PackingRow): PackRowModel => ({
  id: row.id,
  number: row.number,
  status: row.status === 'PACKED' ? 'PACKED' : 'DRAFT',
  carrier: carrierOf(row.carrierCode),
  garments: row.garments,
  cartons: row.parcels,
})

function documentsModel(loaded: Loaded, jobs: readonly Job[], printLabels: boolean) {
  const state = documentsState(loaded.packing, loaded.labels, { printLabels })
  const trackingNumbers = (loaded.labels?.parcels ?? [...loaded.packing.parcels].sort((a, b) => a.seq - b.seq).map((parcel) => ({ seq: parcel.seq, trackingNumber: parcel.trackingNumber }))).map((parcel) => ({ seq: parcel.seq, trackingNumber: parcel.trackingNumber }))
  return { ...state, trackingNumbers, jobs: jobs.map(({ version: _version, ...job }) => job) }
}

/** The bench step as the view draws it, from the bench read and the screen's own state. */
function benchModel(
  loaded: Loaded,
  screen: {
    flash: ScanFlash | null
    outOf: string | null
    choosing: { code: string; cellIds: readonly string[] } | null
    close: CloseChoice | null
    marks: { note: MarksNote; job: { status: JobStatus } | null } | null
    pdf: { bytes: Uint8Array; number: string } | 'loading' | null
    printedMarks: readonly number[] | null
  },
  items: readonly QueueItem[],
): BenchStep {
  const bench = loaded.bench!
  const grid = packGrid(bench)
  const cartons = cartonsOf(bench)
  const left = benchLeft(bench, cartons)
  const out = screen.outOf ? (cartons.find((carton) => carton.id === screen.outOf) ?? null) : null
  const marksCarton = screen.marks ? bench.cartons.find((carton) => carton.id === screen.marks!.note.cartonId) : undefined
  return {
    grid,
    cartons,
    current: currentCartonOf(cartons),
    left,
    main: benchMain(cartons, left),
    hold: bench.hold ? holdReasonOf(bench.hold.reason) : null,
    flash: screen.flash,
    takeOut: out ? { cartonId: out.id, seq: out.seq } : null,
    choosing: screen.choosing?.cellIds ?? null,
    close: screen.close ? { choice: screen.close, types: bench.packagingTypes, suggestedId: bench.suggestedPackagingTypeId, held: closeHeld(screen.close, bench.packagingTypes), overweightMax: overweight(screen.close, bench.packagingTypes) } : null,
    marks: screen.marks
      ? { note: screen.marks.note, job: screen.marks.job?.status ?? null, facts: marksCarton ? { code: cartonMarkCode(bench.shipment.number, marksCarton.seq), garments: marksCarton.garments, ...marksFacts(marksCarton) } : null }
      : null,
    printedMarks: screen.printedMarks,
    kept: keptScans(items, bench.shipment.id),
    pdf: screen.pdf,
  }
}
