'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import type { TaskOutcome, TaskProblem } from '../shared/task-api'
import {
  addParcel,
  listPacking,
  lookupSerial,
  markPacked,
  markUnpacked,
  packSerial,
  placeLine,
  printDocuments,
  printLabels,
  readJob,
  readLabels,
  readPacking,
  removeParcel,
  retryJob,
  weighParcel,
  type JobStatus,
  type Labels,
  type Packing,
  type PackingRow,
} from './api'
import {
  carrierOf,
  cartonsOf,
  cellLabel,
  cellsOf,
  currentCarton,
  documentsState,
  jobMoving,
  readyRows,
  scanTarget,
  serialRefusal,
  serialRefusalOfMessage,
  shipmentModel,
  unpackHeld,
  weightText,
  weightValue,
  type PackCell,
} from './model'
import { PackView, type JobModel, type PackAction, type PackRowModel, type PackStep, type ScanNote } from './view/PackView'

/**
 * The live SCR-098 (`/floor/pack`): the packing bench. It reads the site's shipments to pack (`GET /shipping/packing`),
 * one shipment as a packer sees it, and its carrier labels; it adds cartons, puts each scanned garment into the current
 * carton (a serial through its lookup first, so a garment quality has not released is refused before anything moves; a
 * batch-tracked garment one at a time from its size's loose line), puts the rest of a size in one tap, weighs a carton
 * to close it, marks the shipment packed (or unpacks it), and prints the carrier labels and the office's DDT and packing
 * list on the station's printers, following each print job. Each write carries the shipment's version as read; a
 * conflict reads it again. Never queued: packing needs the network; offline the last read stays with its time.
 */

interface Loaded {
  readonly packing: Packing
  readonly labels: Labels | null
}

interface Job extends JobModel {
  readonly version: number | null
}

type Stage = { kind: 'list' } | { kind: 'pack' } | { kind: 'documents' } | { kind: 'done'; number: string; cartons: number; labelsPrinted: boolean }

const memory = new AsOfMemory<Loaded>(20)
const listMemory = new AsOfMemory<PackingRow[]>(1)
const POLL_MS = 3_000
/** While the office has not issued the DDT or bought the labels: read the shipment again now and then. */
const WAIT_MS = 10_000

export function FloorPack() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.pack', { showHome: true })
  const { api, me, online, sessionEnded } = store
  const permissions = useMemo(() => new Set(me?.permissions ?? []), [me?.permissions])
  const can = { pack: permissions.has('shipping.pack'), printLabels: permissions.has('print.labels'), lookup: permissions.has('production.serials') }

  const [stage, setStage] = useState<Stage>({ kind: 'list' })
  const [rows, setRows] = useState<PackingRow[] | null>(null)
  const [scanned, setScanned] = useState<{ code: string; why: 'notFound' | 'serialFirst' } | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const current = useRef<Loaded | null>(null)
  current.current = loaded
  const [picked, setPicked] = useState<string | null>(null)
  const [weigh, setWeigh] = useState<{ cartonId: string; seq: number; value: number | null } | null>(null)
  const [note, setNote] = useState<ScanNote | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ problem: TaskProblem; code?: string | null } | null>(null)
  const [notice, setNotice] = useState<TaskProblem | null>(null)
  const [busy, setBusy] = useState(false)
  const taken = useRef(false)

  const ended = (outcome: { ok: false; problem: TaskProblem }) => {
    if (outcome.problem.kind === 'signedOut') void sessionEnded()
  }

  const keep = useCallback((next: Loaded) => {
    memory.keep(next.packing.id, next)
    current.current = next
    setLoaded(next)
  }, [])

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
    async (id: string, code?: string | null): Promise<Loaded | null> => {
      const answer = await readPacking(api, id)
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
        setProblem({ problem: answer.problem, code: code ?? null })
        return null
      }
      const packing = answer.value.shipment
      const labels = packing.status === 'DRAFT' ? null : await readLabels(api, id)
      const next: Loaded = { packing, labels: labels?.ok ? labels.value : (current.current?.packing.id === id ? current.current.labels : null) }
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

  const open = useCallback(
    async (id: string, code?: string | null) => {
      setScanned(null)
      setProblem(null)
      setNotice(null)
      setNote(null)
      setPicked(null)
      setWeigh(null)
      setBusy(true)
      const next = await loadShipment(id, code)
      setBusy(false)
      if (!next) return
      if (next.packing.status === 'DRAFT') return setStage({ kind: 'pack' })
      enterDocuments(next)
    },
    [loadShipment, enterDocuments],
  )

  // ---- writes: each answers the packing view after it ---------------------------------------------------------------------

  /** One write's answer: the shipment as it is now, or the problem said on the step (a conflict reads it again). */
  const settle = useCallback(
    async (outcome: TaskOutcome<{ shipment: Packing }>): Promise<Packing | null> => {
      if (outcome.ok) {
        keep({ packing: outcome.value.shipment, labels: current.current?.labels ?? null })
        return outcome.value.shipment
      }
      ended(outcome)
      feedback('error')
      if (outcome.problem.kind === 'conflict' && current.current) await loadShipment(current.current.packing.id)
      setNotice(outcome.problem)
      return null
    },
    [keep, feedback, loadShipment],
  )

  /** The carton a garment goes into: the current one, else a new carton (the scan adds it: 0 taps). */
  const cartonFor = async (packing: Packing): Promise<{ packing: Packing; cartonId: string; seq: number } | null> => {
    const carton = currentCarton(cartonsOf(packing.parcels, packing.lines), picked)
    if (carton) return { packing, cartonId: carton.id, seq: carton.seq }
    const answer = await addParcel(api, packing.id, packing.version)
    if (!answer.ok) {
      await settle(answer)
      return null
    }
    keep({ packing: answer.value.shipment, labels: current.current?.labels ?? null })
    setPicked(answer.value.parcelId)
    const made = answer.value.shipment.parcels.find((parcel) => parcel.id === answer.value.parcelId)
    return { packing: answer.value.shipment, cartonId: answer.value.parcelId, seq: made?.seq ?? answer.value.shipment.parcels.length }
  }

  /** One batch-tracked garment of the cell into the current carton (from the cell's line not yet in a carton). */
  const putOne = async (cell: PackCell, code: string) => {
    const packing = current.current?.packing
    if (!packing) return
    setBusy(true)
    setNotice(null)
    const target = await cartonFor(packing)
    if (!target) return setBusy(false)
    const line = target.packing.lines.find((entry) => entry.workOrderSizeId === cell.id && entry.parcelId === null)
    if (!line) {
      setBusy(false)
      feedback('error')
      return setNote({ kind: 'refused', code, why: 'batchDone', cell: cellLabel(cell) })
    }
    const after = await settle(await placeLine(api, target.packing.id, line.id, { version: target.packing.version, parcelId: target.cartonId, quantity: 1 }))
    setBusy(false)
    if (!after) return
    feedback('success')
    setNote({ kind: 'packed', code, cell: `${cell.styleCode} ${cellLabel(cell)}`, carton: target.seq })
  }

  /** A serial label: what it is first (released? on this shipment?), then a garment of its size into the carton with it. */
  const putSerial = async (code: string) => {
    const packing = current.current?.packing
    if (!packing) return
    setBusy(true)
    setNotice(null)
    let cellId: string | null = null
    if (can.lookup) {
      const found = await lookupSerial(api, code)
      if (!found.ok) {
        ended(found)
        if (found.problem.kind === 'notFound') {
          setBusy(false)
          feedback('error')
          return setNote({ kind: 'refused', code, why: 'unknown' })
        }
      } else if (!found.value.serial) {
        setBusy(false)
        feedback('error')
        return setNote({ kind: 'refused', code, why: 'unknown' })
      } else {
        const refusal = serialRefusal(found.value.serial, packing.lines)
        if (refusal) {
          setBusy(false)
          feedback('error')
          return setNote({ kind: 'refused', code, why: refusal })
        }
        cellId = found.value.serial.workOrderSizeId
      }
    }
    const target = await cartonFor(packing)
    if (!target) return setBusy(false)
    let base = target.packing
    if (cellId) {
      const room = base.lines.find((line) => line.workOrderSizeId === cellId && line.parcelId === target.cartonId && line.serials.length < line.quantity)
      if (!room) {
        const loose = base.lines.find((line) => line.workOrderSizeId === cellId && line.parcelId === null && line.serials.length === 0)
        if (!loose) {
          setBusy(false)
          feedback('error')
          return setNote({ kind: 'refused', code, why: 'noRoom' })
        }
        const placed = await settle(await placeLine(api, base.id, loose.id, { version: base.version, parcelId: target.cartonId, quantity: 1 }))
        if (!placed) return setBusy(false)
        base = placed
      }
    }
    const answer = await packSerial(api, base.id, { version: base.version, serial: code, parcelId: target.cartonId })
    setBusy(false)
    if (!answer.ok && answer.problem.kind === 'conflict' && answer.problem.message) {
      const why = serialRefusalOfMessage(answer.problem.message)
      if (why) {
        feedback('error')
        return setNote({ kind: 'refused', code, why })
      }
    }
    if (!answer.ok && answer.problem.kind === 'notFound') {
      feedback('error')
      return setNote({ kind: 'refused', code, why: 'unknown' })
    }
    const after = await settle(answer)
    if (!after) return
    feedback('success')
    const line = after.lines.find((entry) => entry.serials.some((serial) => codeKey(serial.serial) === codeKey(code)))
    setNote({ kind: 'packed', code, cell: line ? `${line.styleCode} ${cellLabel(line)}` : '', carton: target.seq })
  }

  // A plain function (not memoised): it reads this render's picked carton and rows.
  const onScan = async (code: string, fromHome: boolean) => {
    if (!me) return
    const read = readScan(code, me.scanTag)
    if (read.kind === 'badge') {
      if (await store.switchTo(read.code)) feedback('error')
      return
    }
    const packing = stage.kind === 'pack' ? (current.current?.packing ?? null) : null
    const target = scanTarget(read, packing, rows ?? listMemory.get('rows')?.value ?? [])
    if (target.kind === 'shipment') {
      feedback('success')
      return void open(target.row.id, target.row.number)
    }
    if (!packing) {
      // On the list: a code that is no shipment of this station. From Home, it is handed on to Scan anything (a work
      // order's traveller, a hide …); a garment's serial waits for its shipment's pack slip.
      const serial = read.kind === 'label' && read.type === 'serial'
      if (fromHome && !serial) return store.openScan(code)
      feedback('error')
      return setScanned({ code: read.code, why: serial ? 'serialFirst' : 'notFound' })
    }
    if (packing.status !== 'DRAFT') {
      feedback('error')
      return setNote({ kind: 'refused', code: read.code, why: 'notDraft' })
    }
    if (!online) {
      feedback('warning')
      return setNote({ kind: 'refused', code: read.code, why: 'offline' })
    }
    switch (target.kind) {
      case 'garment':
        return void putOne(target.cell, read.code)
      case 'serial':
        return void putSerial(read.code)
      case 'serialTracked':
        feedback('error')
        return setNote({ kind: 'refused', code: read.code, why: 'serialTracked', cell: cellLabel(target.cell) })
      case 'batchDone':
        feedback('error')
        return setNote({ kind: 'refused', code: read.code, why: 'batchDone' })
      default:
        feedback('error')
        return setNote({ kind: 'refused', code: read.code, why: 'unknown' })
    }
  }
  const scanRef = useRef(onScan)
  scanRef.current = onScan

  // On arrival: the list, and the code Home's scan router handed over (a pack slip, a garment's label).
  useEffect(() => {
    if (taken.current || !me) return
    taken.current = true
    if (!can.pack) return
    void loadList().then(() => {
      const code = store.takeScan()
      if (code) void scanRef.current(code, true)
    })
  }, [me, can.pack, loadList, store])

  // Print jobs move queued → sent → printed or failed: read them again while one is on its way.
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

  // Packed, waiting for the office (the DDT, the labels): read the shipment again now and then.
  const waiting = loaded && stage.kind === 'documents' ? documentsState(loaded.packing, loaded.labels, { printLabels: can.printLabels }) : null
  const officeWait = waiting !== null && (waiting.documents.held === 'officeIssues' || waiting.labels.held === 'officeBuys')
  useEffect(() => {
    if (!officeWait || !online || !loaded) return
    const timer = window.setTimeout(() => void loadShipment(loaded.packing.id), WAIT_MS)
    return () => window.clearTimeout(timer)
  }, [officeWait, online, loaded, loadShipment])

  // ---- the actions ------------------------------------------------------------------------------------------------------

  const toList = () => {
    setLoaded(null)
    current.current = null
    setPicked(null)
    setWeigh(null)
    setNote(null)
    setJobs([])
    setStage({ kind: 'list' })
    void loadList()
  }

  const back = () => {
    setNotice(null)
    setProblem(null)
    if (weigh) return setWeigh(null)
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

  const onAction = async (action: PackAction) => {
    const value = current.current
    const packing = value?.packing ?? null
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
      case 'add-carton': {
        if (!packing || !online) return
        setBusy(true)
        setNotice(null)
        const answer = await addParcel(api, packing.id, packing.version)
        setBusy(false)
        if (!answer.ok) return void (await settle(answer))
        keep({ packing: answer.value.shipment, labels: value?.labels ?? null })
        setPicked(answer.value.parcelId)
        setNote(null)
        return feedback('success')
      }
      case 'pick-carton':
        setPicked(action.id)
        return setNote(null)
      case 'remove-carton': {
        if (!packing || !online) return
        setBusy(true)
        const after = await settle(await removeParcel(api, packing.id, action.id, packing.version))
        setBusy(false)
        if (after && picked === action.id) setPicked(null)
        return
      }
      case 'put-rest': {
        if (!packing || !online) return
        const cell = cellsOf(packing.lines).find((entry) => entry.id === action.cellId)
        if (!cell || cell.loose === 0) return
        setBusy(true)
        setNotice(null)
        const target = await cartonFor(packing)
        if (!target) return setBusy(false)
        let base: Packing | null = target.packing
        let moved = 0
        for (const line of target.packing.lines.filter((entry) => entry.workOrderSizeId === cell.id && entry.parcelId === null)) {
          if (!base) break
          const latest: Packing = base
          base = await settle(await placeLine(api, latest.id, line.id, { version: latest.version, parcelId: target.cartonId }))
          if (base) moved += line.quantity
        }
        setBusy(false)
        if (moved > 0) {
          feedback('success')
          setNote({ kind: 'packed', code: cell.batchNumber ?? cell.workOrderNumber, cell: `${cell.styleCode} ${cellLabel(cell)}`, carton: target.seq, rest: moved })
        }
        return
      }
      case 'close-carton': {
        if (!packing) return
        const carton = currentCarton(cartonsOf(packing.parcels, packing.lines), picked)
        if (!carton || carton.garments === 0) return
        return setWeigh({ cartonId: carton.id, seq: carton.seq, value: weightValue(carton.weightKg) })
      }
      case 'weigh-value':
        return weigh ? setWeigh({ ...weigh, value: action.value }) : undefined
      case 'weigh-cancel':
        return setWeigh(null)
      case 'weigh-confirm': {
        if (!packing || !weigh || !online || weigh.value === null) return
        const text = weightText(weigh.value)
        if (!text) return
        setBusy(true)
        setNotice(null)
        const after = await settle(await weighParcel(api, packing.id, weigh.cartonId, { version: packing.version, grossWeightKg: text }))
        setBusy(false)
        if (!after) return
        feedback('success')
        setWeigh(null)
        setPicked(null)
        return setNote(null)
      }
      case 'packed': {
        if (!packing || !online) return
        setBusy(true)
        setNotice(null)
        const after = await settle(await markPacked(api, packing.id, packing.version))
        if (!after) return setBusy(false)
        const next = await loadShipment(after.id)
        setBusy(false)
        feedback('success')
        setNote(null)
        if (next) enterDocuments(next)
        return
      }
      case 'unpack': {
        if (!packing || !online) return
        setBusy(true)
        setNotice(null)
        const after = await settle(await markUnpacked(api, packing.id, packing.version))
        setBusy(false)
        if (!after) return
        setJobs([])
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
      case 'finish':
        if (!packing) return
        return setStage({ kind: 'done', number: packing.number, cartons: packing.parcels.length, labelsPrinted: jobs.some((job) => job.what === 'LABEL' && job.status !== 'FAILED') })
    }
  }

  // ---- keys: Enter = the step's main action, Esc = back ---------------------------------------------------------------------

  const model = loaded ? shipmentModel(loaded.packing, picked) : null
  const enter = (): PackAction | null => {
    if (busy || !model) return stage.kind === 'done' ? { type: 'next' } : null
    switch (stage.kind) {
      case 'pack':
        if (weigh) return { type: 'weigh-confirm' }
        if (model.status !== 'DRAFT') return { type: 'documents' }
        if (model.left.length === 0) return { type: 'packed' }
        return model.current && model.current.garments > 0 ? { type: 'close-carton' } : null
      case 'documents':
        return jobs.length > 0 ? { type: 'finish' } : { type: 'print' }
      case 'done':
        return { type: 'next' }
      default:
        return null
    }
  }
  useFloorKeys({ enter: () => void ((action) => action && onAction(action))(enter()), escape: () => back() })

  if (!me) return null

  const step: PackStep = !can.pack
    ? { kind: 'noPermission' }
    : problem
      ? { kind: 'problem', problem: problem.problem, code: problem.code ?? null }
      : stage.kind === 'done'
        ? { kind: 'done', number: stage.number, cartons: stage.cartons, labelsPrinted: stage.labelsPrinted }
        : stage.kind === 'list' || !loaded || !model
          ? rows === null
            ? { kind: 'loading' }
            : { kind: 'list', rows: rows.map(rowModel), scanned }
          : stage.kind === 'pack'
            ? { kind: 'pack', shipment: model, weigh, note, unpackHeld: unpackHeld(model.cartons, loaded.packing) }
            : { kind: 'documents', shipment: model, documents: documentsModel(loaded, jobs, can.printLabels), unpackHeld: unpackHeld(model.cartons, loaded.packing) }

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
