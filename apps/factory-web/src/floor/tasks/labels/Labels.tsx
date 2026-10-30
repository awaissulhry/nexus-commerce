'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { useWedgeScans } from '../scans/wedge'
import { AsOfMemory } from '../shared/as-of'
import type { TaskProblem } from '../shared/task-api'
import { freshKey, printLabels, readJob, readLabels, reprintCell, reprintSerial, retryJob, scanCode, type Cell, type LabelsView as LabelsAnswer, type Refusal, type ReprintCellAnswer } from './api'
import { allLabelled, firstCell, jobMoving, jobsOf, labelsScan, printerChoice, printerIdOf, problemsOf, type JobModel } from './model'
import { labelsStepOf, orderOf } from './steps'
import { LabelsView, type LabelsAction, type LabelsNote, type LabelsStep, type ReprintReason } from './view/LabelsView'

/**
 * The live SCR-096 (`/floor/labels`): garment labels at the final operation. It reads what a scanned code names
 * (`GET /production/serials/scan`), the work order's labels with the label of the picked size
 * (`GET /production/serials/work-orders/:id?cellId=`), prints one size or all of them on the site's label printer
 * (`POST …/labels`, one Idempotency-Key per print, kept while its answer is lost), prints a size's batch labels or one
 * serial's label again with a reason, and follows each print job (`GET /print/jobs/:id`, Retry). Never queued: every
 * garment label is logged by the office at once; offline the last read stays with its time and every print waits.
 */

interface Loaded {
  readonly view: LabelsAnswer
  /** The cell whose label `view.preview` is (the API renders the one asked). */
  readonly previewCell: string | null
}

type Stage = { kind: 'scan' } | { kind: 'labels' } | { kind: 'reprint'; cellId: string; count: number | null } | { kind: 'done' }

/** The reason sent with a reprint: fixed words, so the office's label log reads the same in any language. */
const REASON_TEXT: Readonly<Record<ReprintReason, string>> = {
  DAMAGED: 'Label damaged or smudged',
  UNREADABLE: 'Print unreadable',
  LOST: 'Label lost',
  JAMMED: 'Printer jammed',
}

const memory = new AsOfMemory<Loaded>(20)
/** The label printer picked when the site has several: kept for the visit. */
let pickedPrinter: string | null = null
const POLL_MS = 3_000

export function FloorLabels() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.labels', { showHome: true })
  const { api, me, online, sessionEnded } = store
  const permissions = useMemo(() => new Set(me?.permissions ?? []), [me?.permissions])
  const can = { serials: permissions.has('production.serials'), jobs: permissions.has('print.view') }

  const [stage, setStage] = useState<Stage>({ kind: 'scan' })
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const current = useRef<Loaded | null>(null)
  current.current = loaded
  const [picked, setPicked] = useState<string | null>(null)
  const [printer, setPrinter] = useState<string | null>(pickedPrinter)
  const [serial, setSerial] = useState<{ id: string; serial: string; workOrderSizeId: string } | null>(null)
  const [jobs, setJobs] = useState<JobModel[]>([])
  const [refused, setRefused] = useState<Refusal[]>([])
  const [problems, setProblems] = useState<{ what: string; problem: string }[]>([])
  const [note, setNote] = useState<LabelsNote | null>(null)
  const [printedAt, setPrintedAt] = useState<Record<string, string>>({})
  const [printedTotal, setPrintedTotal] = useState(0)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ problem: TaskProblem; code?: string | null } | null>(null)
  const [notice, setNotice] = useState<TaskProblem | null>(null)
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState<string | null>(null)
  /** The print on its way: its key is kept while its answer is lost (a resend is answered, never printed twice). */
  const pending = useRef<{ what: string; key: string } | null>(null)
  const taken = useRef(false)

  const keyFor = (what: string): string => {
    if (pending.current?.what !== what) pending.current = { what, key: freshKey() }
    return pending.current.key
  }
  const settled = () => {
    pending.current = null
  }

  const keep = useCallback((next: Loaded) => {
    memory.keep(next.view.workOrder.id, next)
    current.current = next
    setLoaded(next)
  }, [])

  // ---- reads ------------------------------------------------------------------------------------------------------------

  /** The work order's labels with the label of `cellId`; offline: the last read of it, with its time. */
  const load = useCallback(
    async (workOrderId: string, cellId: string | null, code?: string | null): Promise<Loaded | null> => {
      const answer = await readLabels(api, workOrderId, cellId)
      if (!answer.ok) {
        if (answer.problem.kind === 'signedOut') {
          void sessionEnded()
          return null
        }
        const kept = memory.get(workOrderId)
        if (kept && (answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable')) {
          current.current = kept.value
          setLoaded(kept.value)
          setAsOf(kept.asOf)
          return kept.value
        }
        if (current.current?.view.workOrder.id === workOrderId) {
          setNotice(answer.problem)
          return current.current
        }
        setProblem({ problem: answer.problem, code: code ?? null })
        return null
      }
      const next: Loaded = { view: answer.value, previewCell: cellId }
      keep(next)
      setAsOf(null)
      return next
    },
    [api, sessionEnded, keep],
  )

  const open = useCallback(
    async (workOrderId: string, cellId: string | null, code?: string | null) => {
      setProblem(null)
      setNotice(null)
      setJobs([])
      setRefused([])
      setProblems([])
      setBusy(true)
      setStage({ kind: 'labels' })
      let next = await load(workOrderId, cellId, code)
      if (next && !next.view.blocked) {
        const first = firstCell(next.view.cells, cellId)
        if (first && first !== next.previewCell) next = (await load(workOrderId, first, code)) ?? next
        setPicked(first)
      } else setPicked(null)
      setBusy(false)
    },
    [load],
  )

  // A plain function (not memoised): it reads this render's state.
  const onScan = async (code: string, fromHome: boolean) => {
    if (!me) return
    const read = readScan(code, me.scanTag)
    const plan = labelsScan(read)
    if (plan.kind === 'badge') {
      if (await store.switchTo(plan.code)) feedback('error')
      return
    }
    if (plan.kind === 'notHere') {
      if (fromHome && plan.why === 'otherLabel') return store.openScan(code)
      feedback('error')
      setNote({ kind: 'notHere', code: plan.code, why: plan.why })
      return setStage((value) => (value.kind === 'labels' ? value : { kind: 'scan' }))
    }
    if (!online) {
      // The lookup is the office's: a work order the tablet read before opens from its memory.
      feedback('warning')
      return setNotice({ kind: 'offline' })
    }
    setBusy(true)
    setNote(null)
    const answer = await scanCode(api, plan.code)
    setBusy(false)
    if (!answer.ok) {
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      feedback('error')
      if (answer.problem.kind === 'notFound' || answer.problem.kind === 'invalid') {
        setNote({ kind: 'notHere', code: plan.code, why: answer.problem.kind === 'invalid' ? 'several' : 'notFound' })
        return setStage((value) => (value.kind === 'labels' ? value : { kind: 'scan' }))
      }
      return setProblem({ problem: answer.problem, code: plan.code })
    }
    feedback('success')
    const found = answer.value
    setSerial(found.serial ? { id: found.serial.id, serial: found.serial.serial, workOrderSizeId: found.serial.workOrderSizeId } : null)
    if (current.current?.view.workOrder.id === found.workOrderId && stage.kind === 'labels') return pick(found.workOrderSizeId ?? picked)
    return open(found.workOrderId, found.workOrderSizeId, found.number)
  }
  const scanRef = useRef(onScan)
  scanRef.current = onScan
  // On the sizes a scanner's burst still arrives (no scan field there): another bundle opens its size, a serial label
  // opens its reprint (the DS wedge rule; a person's own key presses pass through).
  useWedgeScans((code) => void scanRef.current(code, false), stage.kind === 'labels' && can.serials)

  /** Another size: shown at once from what is known; its label is read (the API renders the size asked). */
  const pick = async (cellId: string | null) => {
    const value = current.current
    if (!value || !cellId) return
    setPicked(cellId)
    setNotice(null)
    if (value.previewCell === cellId || !online) return
    setReading(cellId)
    await load(value.view.workOrder.id, cellId)
    setReading(null)
  }

  // On arrival: a code Home's scan router handed over (none routes here yet: a scan on this screen opens the job).
  useEffect(() => {
    if (taken.current || !me) return
    taken.current = true
    if (!can.serials) return
    const code = store.takeScan()
    if (code) void scanRef.current(code, true)
  }, [me, can.serials, store])

  // Print jobs move queued → sent → printed or failed: read them again while one is on its way.
  useEffect(() => {
    if (!online || !can.jobs || !jobs.some((job) => jobMoving(job.status))) return
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
  }, [jobs, online, api, can.jobs])

  // ---- writes -------------------------------------------------------------------------------------------------------------

  /** The cells after a print: the answer's counts over the view (the gate and the preview stay as read). */
  const withCells = (value: Loaded, cells: readonly Cell[]): Loaded => ({
    ...value,
    view: { ...value.view, cells: value.view.cells.map((cell) => ({ ...cell, ...(cells.find((entry) => entry.workOrderSizeId === cell.workOrderSizeId) ?? {}) })) },
  })

  const failed = async (outcome: { problem: TaskProblem }) => {
    if (outcome.problem.kind === 'signedOut') return void sessionEnded()
    feedback('error')
    // A rule's refusal or a conflict is final for this key; a lost answer keeps it for the resend.
    if (outcome.problem.kind === 'refused' || outcome.problem.kind === 'conflict' || outcome.problem.kind === 'invalid' || outcome.problem.kind === 'forbidden') settled()
    setNotice(outcome.problem)
    const value = current.current
    if (value && (outcome.problem.kind === 'refused' || outcome.problem.kind === 'conflict')) await load(value.view.workOrder.id, picked)
  }

  const print = async (cells: { workOrderSizeId: string }[] | null) => {
    const value = current.current
    if (!value || !online) return
    const choice = printerChoice(value.view.printers, printer)
    setBusy(true)
    setNotice(null)
    setNote(null)
    const answer = await printLabels(api, value.view.workOrder.id, { cells, printerId: printerIdOf(choice) }, keyFor(`print:${value.view.workOrder.id}:${cells?.map((cell) => cell.workOrderSizeId).join(',') ?? 'all'}`))
    setBusy(false)
    if (!answer.ok) return failed(answer)
    settled()
    const made = jobsOf(answer.value.printed)
    const count = answer.value.printed.reduce((sum, line) => sum + line.count, 0)
    const now = new Date().toISOString()
    keep(withCells(value, answer.value.cells))
    setJobs((known) => [...made, ...known.filter((job) => !made.some((entry) => entry.id === job.id))])
    setRefused(answer.value.refused)
    setProblems(problemsOf(answer.value.printed))
    setPrintedAt((known) => ({ ...known, ...Object.fromEntries(answer.value.printed.map((line) => [line.workOrderSizeId, now])) }))
    if (!answer.value.replayed) setPrintedTotal((total) => total + count)
    setNote({ kind: 'printed', count, sizes: answer.value.printed.map((line) => `${line.colourwayCode} ${line.size}`).join(', ') })
    feedback(count > 0 ? 'success' : 'warning')
  }

  const reprint = async (cellId: string, count: number | null, reason: ReprintReason) => {
    const value = current.current
    if (!value || !online) return
    const choice = printerChoice(value.view.printers, printer)
    const cell = value.view.cells.find((entry) => entry.workOrderSizeId === cellId)
    if (!cell) return
    setBusy(true)
    setNotice(null)
    const serialHere = value.view.tracking === 'SERIAL' && serial?.workOrderSizeId === cellId ? serial : null
    const answer = serialHere
      ? await reprintSerial(api, serialHere.id, { reason: REASON_TEXT[reason], printerId: printerIdOf(choice) }, keyFor(`reprint:${serialHere.id}:${reason}`))
      : await reprintCell(api, value.view.workOrder.id, { workOrderSizeId: cellId, count: Math.max(1, Math.min(count ?? cell.labelled, cell.labelled)), reason: REASON_TEXT[reason], printerId: printerIdOf(choice) }, keyFor(`reprint:${cellId}:${count}:${reason}`))
    setBusy(false)
    if (!answer.ok) return failed(answer)
    settled()
    const made = jobsOf([answer.value.reprinted], true)
    if (!serialHere) keep(withCells(value, (answer.value as ReprintCellAnswer).cells))
    setJobs((known) => [...made, ...known.filter((job) => !made.some((entry) => entry.id === job.id))])
    setProblems(problemsOf([answer.value.reprinted]))
    setNote({ kind: 'reprinted', count: answer.value.reprinted.count, what: serialHere ? serialHere.serial : `${cell.colourwayCode} ${cell.size}` })
    setStage({ kind: 'labels' })
    feedback('success')
  }

  // ---- the actions ------------------------------------------------------------------------------------------------------

  const toScan = () => {
    setLoaded(null)
    current.current = null
    setPicked(null)
    setSerial(null)
    setJobs([])
    setRefused([])
    setProblems([])
    setNote(null)
    setNotice(null)
    setProblem(null)
    setAsOf(null)
    setPrintedTotal(0)
    setStage({ kind: 'scan' })
  }

  const back = () => {
    setNotice(null)
    if (stage.kind === 'reprint') return setStage({ kind: 'labels' })
    if (stage.kind === 'scan' && !problem) return router.push('/floor')
    toScan()
  }

  const onAction = async (action: LabelsAction) => {
    const value = current.current
    switch (action.type) {
      case 'scan':
        return onScan(action.code, false)
      case 'pick':
        return pick(action.cellId)
      case 'printer':
        pickedPrinter = action.printerId
        return setPrinter(action.printerId)
      case 'print':
        return picked ? print([{ workOrderSizeId: picked }]) : undefined
      case 'print-all':
        return print(null)
      case 'reprint': {
        const cell = value?.view.cells.find((entry) => entry.workOrderSizeId === picked)
        if (!cell) return
        return setStage({ kind: 'reprint', cellId: cell.workOrderSizeId, count: cell.labelled })
      }
      case 'reprint-count':
        return stage.kind === 'reprint' ? setStage({ ...stage, count: action.value }) : undefined
      case 'reprint-reason':
        return stage.kind === 'reprint' ? reprint(stage.cellId, stage.count, action.reason) : undefined
      case 'cancel':
        return setStage({ kind: 'labels' })
      case 'retry-job': {
        const job = jobs.find((entry) => entry.id === action.jobId)
        if (!job || !online) return
        const answer = await retryJob(api, { id: job.id, version: job.version })
        if (!answer.ok) return void failed(answer)
        return setJobs((known) => known.map((entry) => (entry.id === job.id ? { ...entry, status: answer.value.job.status, detail: answer.value.job.lastError, version: answer.value.job.version } : entry)))
      }
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'retry':
        setProblem(null)
        if (value) return void open(value.view.workOrder.id, picked)
        return toScan()
      case 'finish':
        return setStage({ kind: 'done' })
      case 'next':
        return toScan()
    }
  }

  // ---- the view model --------------------------------------------------------------------------------------------------

  const view = loaded?.view ?? null
  const order = view ? orderOf(view) : null
  const labelsStep = view ? labelsStepOf({ view, previewCell: loaded?.previewCell ?? null, picked, printer, serial, online, busy, jobs, refused, problems, note, reading, printedTotal }) : null
  const size = labelsStep?.picked ?? null
  const main = labelsStep?.main ?? { kind: 'none' as const, held: 'nothingLeft' as const }

  const enter = (): LabelsAction | null => {
    if (busy) return null
    switch (stage.kind) {
      case 'labels':
        if (main.kind === 'print' && !main.held) return { type: 'print' }
        if ((main.kind === 'reprint' || main.kind === 'reprintSerial') && !main.held) return { type: 'reprint' }
        return view && allLabelled(view.cells) && jobs.length > 0 ? { type: 'finish' } : null
      case 'reprint':
        // design labels.reprint: Enter = Cancel (a reprint is never one key away).
        return { type: 'cancel' }
      case 'done':
        return { type: 'next' }
      default:
        return null
    }
  }
  useFloorKeys({ enter: () => void ((action) => action && onAction(action))(enter()), escape: () => back() })

  if (!me) return null

  let step: LabelsStep
  if (!can.serials) step = { kind: 'noPermission' }
  else if (problem) step = { kind: 'problem', problem: problem.problem, code: problem.code ?? null }
  else if (stage.kind === 'done') step = { kind: 'done', number: view?.workOrder.number ?? '', labels: printedTotal }
  else if (stage.kind === 'scan') step = { kind: 'scan', note }
  else if (!view || !order) step = { kind: 'loading' }
  else if (view.blocked) step = { kind: 'blocked', order, refusal: view.blocked }
  else if (stage.kind === 'reprint' && size) {
    step = { kind: 'reprint', order, size: { ...size }, serial: view.tracking === 'SERIAL' && serial?.workOrderSizeId === size.id ? serial.serial : null, count: stage.count ?? size.labelled, printedAt: printedAt[size.id] ?? null, held: main.held }
  } else step = labelsStep ?? { kind: 'loading' }

  return <LabelsView model={{ frame, online, step, asOf, busy, notice }} onFrame={onFrame} onAction={(action) => void onAction(action)} camera={zxingCamera} />
}
