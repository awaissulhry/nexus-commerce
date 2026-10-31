'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useT } from '../../../lib/i18n/provider'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import { floorStepUp, steppedUp } from '../shared/step-up'
import type { TaskProblem } from '../shared/task-api'
import type { PinProblem } from '../shared/view/TaskParts'
import { listBeforeRead, readListReasons } from '../reasons/api'
import type { PickerList } from '../reasons/model'
import {
  decide,
  freshKey,
  holdLot,
  listBench,
  openInspection,
  printLabels,
  putDefects,
  readFinal,
  readInspection,
  readJob,
  recordChecklist,
  releaseCell,
  retryJob,
  type BenchHold,
  type BenchRow,
  type FinalState,
  type InspectionRead,
  type PrintJob,
} from './api'
import {
  benchAssignee,
  checklistComplete,
  failItem,
  FAIL_REASONS,
  groupState,
  holdHeld,
  holdQuantity,
  labelsToPrint,
  mainAction,
  nextGroup,
  passGroup,
  passItem,
  releaseHeld,
  suggestedLot,
  suggestedPlan,
  withDefect,
  withoutDefect,
  withPlanValue,
  reasonOfNote,
  noteOf,
  type Answer,
  type Check,
  type ChecklistGroup,
  type Plan,
  type PlanField,
} from './model'
import { FinalView, type BenchRowModel, type CellModel, type FinalAction, type FinalStep, type HoldDialogModel, type InspectionModel, type JobModel, type OrderModel } from './view/FinalView'

/**
 * The live SCR-097 (`/floor/final`): the inspection bench. It reads the site's work orders to inspect (or the one a
 * traveller names), one work order's final state, the inspection; it records the checklist and the defects, signs the
 * result and releases per colour and size with the PIN (POST /floor/step-up when the 2-minute window has passed, then
 * the SAME call again with the same Idempotency-Key), and prints the garment labels when they are what holds a release
 * and the person may print them here. Never queued: inspections and releases need the network; offline the last work
 * order read stays on screen with its time and every write waits, with the reason.
 */

type Stage =
  | { kind: 'pick' }
  | { kind: 'gate' }
  | { kind: 'plan'; plan: Plan; field: PlanField | null; key: string }
  | { kind: 'checklist'; group: ChecklistGroup; failing: string | null }
  | { kind: 'sign'; result: 'PASS' | 'FAIL'; statement: boolean; key: string }
  | { kind: 'release'; cellId: string; quantity: number; signing: boolean; refused: Check[]; key: string }
  | { kind: 'labels'; cellId: string; jobs: PrintJob[]; refused: string | null; key: string; from: 'gate' | 'release' }
  | { kind: 'done'; cell: string; quantity: number; releaseNumber: string | null; secondPerson: boolean }

interface Loaded {
  readonly row: BenchRow
  readonly final: FinalState
  /** The work order's OPEN inspection as this person reads it, or null. */
  readonly read: InspectionRead | null
}

const memory = new AsOfMemory<Loaded>(30)
const listMemory = new AsOfMemory<BenchRow[]>(1)
/** B-W2a-75: Hold lot asks why from the tenant's HOLD list, in the floor's one reason picker (B-W2a-F6). */
const HOLD_LISTS = ['HOLD'] as const
const POLL_MS = 3_000

export function FloorFinal() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const t = useT('floor-final')
  const { frame, onFrame } = store.frame('tile.final', { showHome: true })
  const { api, me, online, sessionEnded, locale } = store
  const permissions = useMemo(() => new Set(me?.permissions ?? []), [me?.permissions])
  const can = { view: permissions.has('quality.inspections.view'), record: permissions.has('quality.inspections.record'), release: permissions.has('quality.garments.release'), labels: permissions.has('production.serials') }

  const [stage, setStage] = useState<Stage>({ kind: 'pick' })
  const [rows, setRows] = useState<BenchRow[] | null>(null)
  const [scanned, setScanned] = useState<{ code: string; why: 'notFound' | 'notReady'; status?: string } | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ problem: TaskProblem; code?: string | null } | null>(null)
  const [notice, setNotice] = useState<TaskProblem | null>(null)
  const [busy, setBusy] = useState(false)
  const [pin, setPin] = useState<PinProblem>(null)
  const [until, setUntil] = useState<string | null>(null)
  // B-W2a-75: the Hold lot dialog (its reasons, the pick, the call's key) and the line after a hold placed here.
  const [hold, setHold] = useState<{ picked: string | null; busy: boolean; problem: TaskProblem | null; key: string } | null>(null)
  const [reasons, setReasons] = useState<PickerList>(() => listBeforeRead(HOLD_LISTS))
  const [held, setHeld] = useState<{ reason: string; ncr: string } | null>(null)
  const taken = useRef(false)

  const fresh = () => steppedUp(until, new Date()) || steppedUp(me?.session.stepUpUntil, new Date())
  const ended = (outcome: { ok: false; problem: TaskProblem }) => {
    if (outcome.problem.kind === 'signedOut') void sessionEnded()
  }

  // ---- reads ------------------------------------------------------------------------------------------------------------

  const loadList = useCallback(async () => {
    const answer = await listBench(api)
    if (answer.ok) {
      listMemory.keep('rows', answer.value.workOrders)
      setRows(answer.value.workOrders)
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

  const loadOrder = useCallback(
    async (row: BenchRow): Promise<Loaded | null> => {
      const final = await readFinal(api, row.id)
      if (!final.ok) {
        if (final.problem.kind === 'signedOut') {
          void sessionEnded()
          return null
        }
        const kept = memory.get(row.id)
        if (kept && (final.problem.kind === 'offline' || final.problem.kind === 'unavailable')) {
          setLoaded(kept.value)
          setAsOf(kept.asOf)
          return kept.value
        }
        setProblem({ problem: final.problem, code: row.number })
        return null
      }
      const open = [...final.value.inspections].reverse().find((entry) => entry.status === 'OPEN')
      const read = open ? await readInspection(api, open.id) : null
      const next: Loaded = { row, final: final.value, read: read?.ok ? read.value : null }
      memory.keep(row.id, next)
      setLoaded(next)
      setAsOf(null)
      return next
    },
    [api, sessionEnded],
  )

  const reload = useCallback(async () => (loaded ? loadOrder(loaded.row) : null), [loaded, loadOrder])

  const openRow = useCallback(
    async (row: BenchRow) => {
      setScanned(null)
      setProblem(null)
      setNotice(null)
      setBusy(true)
      const next = await loadOrder(row)
      setBusy(false)
      if (next) setStage({ kind: 'gate' })
    },
    [loadOrder],
  )

  const onScan = useCallback(
    async (code: string, fromHome: boolean) => {
      if (!me) return
      const read = readScan(code, me.scanTag)
      if (read.kind === 'badge') {
        if (await store.switchTo(read.code)) feedback('error')
        return
      }
      // Another kind of label (a bundle, a serial, a hide …): Scan anything opens its card.
      if (read.kind === 'label' && read.type !== 'workOrder') return store.openScan(code)
      setBusy(true)
      const answer = await listBench(api, read.code)
      setBusy(false)
      if (!answer.ok) {
        ended(answer)
        const kept = [...(listMemory.get('rows')?.value ?? [])].find((row) => codeKey(row.number) === codeKey(read.code))
        if (kept) return void openRow(kept)
        feedback('error')
        return setProblem({ problem: answer.problem, code: read.code })
      }
      const row = answer.value.workOrders.find((entry) => codeKey(entry.number) === codeKey(read.code)) ?? answer.value.workOrders[0]
      if (!row) {
        if (fromHome) return store.openScan(code)
        feedback('error')
        return setScanned({ code: read.code, why: 'notFound' })
      }
      if (!['RELEASED', 'IN_PROGRESS', 'COMPLETED'].includes(row.status)) {
        feedback('warning')
        setStage({ kind: 'pick' })
        return setScanned({ code: row.number, why: 'notReady', status: row.status })
      }
      feedback('success')
      await openRow(row)
    },
    [api, me, store, feedback, openRow],
  )

  useEffect(() => {
    if (taken.current || !me) return
    taken.current = true
    if (!can.view) return
    void loadList()
    const code = store.takeScan()
    if (code) void onScan(code, true)
  }, [me, can.view, loadList, onScan, store])

  // Print jobs move queued → sent → printed or failed: read them again while one is on its way.
  useEffect(() => {
    if (stage.kind !== 'labels' || !online) return
    if (!stage.jobs.some((job) => job.status === 'QUEUED' || job.status === 'SENT')) return
    const timer = window.setTimeout(async () => {
      const next = await Promise.all(
        stage.jobs.map(async (job) => {
          if (job.status !== 'QUEUED' && job.status !== 'SENT') return job
          const answer = await readJob(api, job.id)
          return answer.ok ? answer.value.job : job
        }),
      )
      setStage((current) => (current.kind === 'labels' ? { ...current, jobs: next } : current))
    }, POLL_MS)
    return () => window.clearTimeout(timer)
  }, [stage, online, api])

  // ---- writes -----------------------------------------------------------------------------------------------------------

  const inspection = loaded?.read?.inspection ?? null

  const record = async (checklist: Answer[], defects?: { reason: (typeof FAIL_REASONS)[number]; add: boolean }) => {
    if (!inspection || !loaded) return null
    setBusy(true)
    setNotice(null)
    let answer = await recordChecklist(api, inspection.id, { version: inspection.version, checklist }, freshKey())
    if (answer.ok && defects) {
      const lines = answer.value.inspection.defects.map((line) => ({ defectClass: line.defectClass, code: line.code, quantity: line.quantity }))
      const next = defects.add ? withDefect(lines, defects.reason, answer.value.inspection.plan.sampleSize) : withoutDefect(lines, defects.reason)
      answer = await putDefects(api, inspection.id, { version: answer.value.inspection.version, defects: next }, freshKey())
    }
    setBusy(false)
    if (!answer.ok) {
      ended(answer)
      feedback('error')
      setNotice(answer.problem)
      if (answer.problem.kind === 'conflict') await reload()
      return null
    }
    const read = { ...loaded.read!, inspection: answer.value.inspection }
    const next = { ...loaded, read }
    memory.keep(loaded.row.id, next)
    setLoaded(next)
    feedback('success')
    return read.inspection
  }

  const runDecide = async (signing: Extract<Stage, { kind: 'sign' }>) => {
    if (!inspection) return
    setBusy(true)
    setNotice(null)
    const answer = await decide(
      api,
      inspection.id,
      {
        version: inspection.version,
        result: signing.result,
        checklist: inspection.checklist,
        ...(loaded?.read?.statementNeeded ? { notMakerStatement: signing.statement } : {}),
      },
      signing.key,
    )
    setBusy(false)
    if (answer.ok) {
      feedback('success')
      setPin(null)
      await reload()
      return setStage({ kind: 'gate' })
    }
    ended(answer)
    if (answer.problem.kind === 'stepUp') return setStage(signing)
    feedback('error')
    setNotice(answer.problem)
  }

  const runRelease = async (release: Extract<Stage, { kind: 'release' }>) => {
    const inspectionId = loaded?.final.inspectionId
    if (!inspectionId || !loaded) return
    setBusy(true)
    setNotice(null)
    const answer = await releaseCell(api, { inspectionId, workOrderSizeId: release.cellId, quantity: release.quantity }, release.key)
    setBusy(false)
    if (answer.ok) {
      feedback('success')
      setPin(null)
      const cell = loaded.final.cells.find((entry) => entry.workOrderSizeId === release.cellId)
      await reload()
      return setStage({ kind: 'done', cell: cell ? `${cell.colourwayCode} ${cell.size}` : '', quantity: answer.value.release.quantity, releaseNumber: answer.value.release.releaseNumber, secondPerson: answer.value.release.secondPerson.reasons.length > 0 })
    }
    ended(answer)
    if (answer.problem.kind === 'stepUp') return setStage({ ...release, signing: true })
    feedback('error')
    if (answer.problem.kind === 'refused') {
      const all = [answer.problem, ...(answer.problem.others ?? [])]
      return setStage({ ...release, signing: false, key: freshKey(), refused: all.map((entry) => ({ code: entry.code as Check['code'], state: 'OPEN', message: entry.message, fix: entry.fix })) })
    }
    setStage({ ...release, signing: false })
    setNotice(answer.problem)
  }

  // ---- Hold lot (B-W2a-75): a reason tile, then ONE call holds the work order's garments and raises the NCR ----

  /** The HOLD reasons for the picker: what this tablet kept at once, then the office's answer (or why not). */
  const readHoldReasons = async () => {
    setReasons(listBeforeRead(HOLD_LISTS))
    const answer = await readListReasons(api, HOLD_LISTS, online)
    if (answer.signedOut) return void sessionEnded()
    setReasons(answer.list)
  }

  const openHold = async () => {
    if (!loaded || !online) return
    setHold({ picked: null, busy: false, problem: null, key: freshKey() })
    await readHoldReasons()
  }

  const confirmHold = async () => {
    if (!hold || !hold.picked || hold.busy || !loaded || !online) return
    const open = loaded.read?.inspection.status === 'OPEN' ? loaded.read.inspection : null
    const current = hold
    setHold({ ...current, busy: true, problem: null })
    const answer = await holdLot(api, loaded.row.id, { reasonCode: current.picked!, quantity: holdQuantity(open ? { lotSize: open.plan.lotSize } : null, loaded.row), inspectionId: open?.id ?? null }, current.key)
    if (!answer.ok) {
      ended(answer)
      feedback('error')
      return setHold({ ...current, busy: false, problem: answer.problem, key: answer.problem.kind === 'offline' || answer.problem.kind === 'unavailable' ? current.key : freshKey() })
    }
    feedback('success')
    setHold(null)
    setHeld({ reason: reasonWord(answer.value.hold, locale), ncr: answer.value.ncr.number })
    await reload()
    setStage({ kind: 'gate' })
  }

  const onPin = async (value: string) => {
    if (!online) return setPin('offline')
    setBusy(true)
    const answer = await floorStepUp(api, value)
    setBusy(false)
    if (!answer.ok) {
      if (answer.problem === 'signedOut') return void sessionEnded()
      feedback('error')
      return setPin(answer.problem)
    }
    setPin(null)
    setUntil(answer.until)
    if (stage.kind === 'sign') await runDecide(stage)
    else if (stage.kind === 'release') await runRelease({ ...stage, signing: false })
  }

  const print = async (labels: Extract<Stage, { kind: 'labels' }>) => {
    if (!loaded) return
    setBusy(true)
    setNotice(null)
    const answer = await printLabels(api, loaded.row.id, labels.cellId, labels.key)
    setBusy(false)
    if (!answer.ok) {
      ended(answer)
      feedback('error')
      if (answer.problem.kind === 'refused') return setStage({ ...labels, refused: `${answer.problem.message} ${answer.problem.fix ?? ''}`.trim() })
      return setNotice(answer.problem)
    }
    const jobs = answer.value.printed.flatMap((line) => [line.job, ...line.serials.map((serial) => serial.job)]).filter((job): job is PrintJob => job !== null)
    const refused = answer.value.refused.map((entry) => `${entry.message} ${entry.fix}`).join(' ') || null
    feedback(jobs.length > 0 ? 'success' : 'warning')
    setStage({ ...labels, jobs, refused })
    await reload()
  }

  // ---- the actions ------------------------------------------------------------------------------------------------------

  const back = () => {
    setNotice(null)
    setPin(null)
    setProblem(null)
    switch (stage.kind) {
      case 'pick':
        return router.push('/floor')
      case 'gate':
      case 'done':
        setHeld(null)
        setStage({ kind: stage.kind === 'done' ? 'gate' : 'pick' })
        if (stage.kind === 'gate') void loadList()
        return
      case 'plan':
        return setStage({ kind: 'gate' })
      case 'checklist':
        if (stage.failing) return setStage({ ...stage, failing: null })
        return setStage({ kind: 'gate' })
      case 'sign':
        return setStage({ kind: 'checklist', group: inspection ? nextGroup(inspection.checklist) : 'LABELS', failing: null })
      case 'release':
        return stage.signing ? setStage({ ...stage, signing: false }) : setStage({ kind: 'gate' })
      case 'labels':
        return stage.from === 'release' ? setStage({ kind: 'release', cellId: stage.cellId, quantity: releasableOf(stage.cellId), signing: false, refused: [], key: freshKey() }) : setStage({ kind: 'gate' })
    }
  }

  const releasableOf = (cellId: string) => Math.max(1, loaded?.final.cells.find((cell) => cell.workOrderSizeId === cellId)?.releasable ?? 1)

  const order = loaded ? orderModel(loaded, { online, can, locale }) : null

  const onAction = async (action: FinalAction) => {
    switch (action.type) {
      case 'scan':
        return onScan(action.code, false)
      case 'open': {
        const row = rows?.find((entry) => entry.id === action.id)
        if (row) await openRow(row)
        return
      }
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'retry':
        setProblem(null)
        if (loaded && stage.kind !== 'pick') return void reload()
        return void loadList()
      case 'next':
        setLoaded(null)
        setStage({ kind: 'pick' })
        return void loadList()
      case 'start': {
        if (!order || !loaded) return
        if (order.main === 'continue' && inspection) return setStage({ kind: 'checklist', group: nextGroup(inspection.checklist), failing: null })
        if (order.main === 'start') return setStage({ kind: 'plan', plan: suggestedPlan(suggestedLot(loaded.row)), field: null, key: freshKey() })
        if (order.main === 'release') {
          const cell = order.cells.find((entry) => entry.held === null) ?? order.cells.find((entry) => entry.releasable > 0)
          if (cell) return setStage({ kind: 'release', cellId: cell.id, quantity: Math.max(1, cell.releasable), signing: false, refused: [], key: freshKey() })
        }
        return
      }
      case 'plan-field':
        return stage.kind === 'plan' ? setStage({ ...stage, field: action.field }) : undefined
      case 'plan-value':
        return stage.kind === 'plan' ? setStage({ ...stage, plan: withPlanValue(stage.plan, action.field, action.value) }) : undefined
      case 'open-inspection': {
        if (stage.kind !== 'plan' || !loaded || !online) return
        setBusy(true)
        setNotice(null)
        const answer = await openInspection(api, { workOrderId: loaded.row.id, ...stage.plan }, stage.key)
        if (!answer.ok) {
          setBusy(false)
          ended(answer)
          feedback('error')
          return setNotice(answer.problem)
        }
        const read = await readInspection(api, answer.value.inspection.id)
        setBusy(false)
        const next: Loaded = { ...loaded, read: read.ok ? read.value : { inspection: answer.value.inspection, workOrder: { ...loaded.final.workOrder }, maker: loaded.final.maker, statementNeeded: false, yours: true } }
        memory.keep(loaded.row.id, next)
        setLoaded(next)
        feedback('success')
        return setStage({ kind: 'checklist', group: 'LABELS', failing: null })
      }
      case 'group':
        return stage.kind === 'checklist' ? setStage({ ...stage, group: action.group, failing: null }) : undefined
      case 'pass-group': {
        if (stage.kind !== 'checklist' || !inspection) return
        const saved = await record(passGroup(inspection.checklist, stage.group))
        if (saved) setStage({ ...stage, group: groupState(saved.checklist, stage.group) === 'passed' || groupState(saved.checklist, stage.group) === 'failed' ? nextGroup(saved.checklist) : stage.group })
        return
      }
      case 'pass-item': {
        if (stage.kind !== 'checklist' || !inspection) return
        const was = inspection.checklist.find((answer) => answer.code === action.code)
        const reason = was?.ok === false ? reasonOfNote(was.note) : null
        await record(passItem(inspection.checklist, action.code), reason ? { reason, add: false } : undefined)
        return
      }
      case 'fail-item':
        return stage.kind === 'checklist' ? setStage({ ...stage, failing: action.code }) : undefined
      case 'fail-reason': {
        if (stage.kind !== 'checklist' || !inspection || !stage.failing) return
        const reason = FAIL_REASONS.find((entry) => entry.code === action.reason)
        if (!reason) return
        const saved = await record(failItem(inspection.checklist, stage.failing, noteOf(t(`reason.${reason.code}`), reason.code)), { reason, add: true })
        if (saved) setStage({ ...stage, failing: null })
        return
      }
      case 'sign': {
        if (!inspection || !checklistComplete(inspection.checklist)) return
        const signing: Extract<Stage, { kind: 'sign' }> = { kind: 'sign', result: inspection.computed.result, statement: inspection.notMakerStatement, key: freshKey() }
        setStage(signing)
        if (fresh() && !loaded?.read?.statementNeeded) await runDecide(signing)
        return
      }
      case 'statement':
        return stage.kind === 'sign' ? setStage({ ...stage, statement: action.value }) : undefined
      case 'pin':
        return onPin(action.pin)
      case 'hold':
        if (!action.open) return setHold(null)
        return void openHold()
      case 'hold-reason':
        return setHold((current) => (current ? { ...current, picked: action.reason, problem: null } : current))
      case 'hold-reasons-retry':
        return void readHoldReasons()
      case 'hold-confirm':
        return void confirmHold()
      case 'release': {
        const cell = order?.cells.find((entry) => entry.id === action.cellId)
        if (!cell || cell.held) return
        return setStage({ kind: 'release', cellId: cell.id, quantity: Math.max(1, cell.releasable), signing: false, refused: [], key: freshKey() })
      }
      case 'release-quantity':
        return stage.kind === 'release' && action.value !== null ? setStage({ ...stage, quantity: action.value }) : undefined
      case 'release-confirm':
        if (stage.kind !== 'release' || !online) return
        if (!fresh()) return setStage({ ...stage, signing: true })
        return runRelease(stage)
      case 'labels':
        return setStage({ kind: 'labels', cellId: action.cellId, jobs: [], refused: null, key: freshKey(), from: stage.kind === 'release' ? 'release' : 'gate' })
      case 'print':
        return stage.kind === 'labels' ? print(stage) : undefined
      case 'retry-job': {
        if (stage.kind !== 'labels') return
        const job = stage.jobs.find((entry) => entry.id === action.jobId)
        if (!job) return
        const answer = await retryJob(api, job)
        if (!answer.ok) {
          ended(answer)
          return setNotice(answer.problem)
        }
        return setStage({ ...stage, jobs: stage.jobs.map((entry) => (entry.id === job.id ? answer.value.job : entry)) })
      }
    }
  }

  // ---- keys: Enter = the step's main action, Esc = back ---------------------------------------------------------------------

  const enter = (): FinalAction | null => {
    switch (stage.kind) {
      case 'gate':
        return { type: 'start' }
      case 'plan':
        return stage.field ? null : { type: 'open-inspection' }
      case 'checklist':
        if (stage.failing || hold || !inspection) return null
        return checklistComplete(inspection.checklist) ? { type: 'sign' } : { type: 'pass-group' }
      case 'release':
        return stage.signing ? null : { type: 'release-confirm' }
      case 'done':
        return { type: 'next' }
      default:
        return null
    }
  }
  useFloorKeys({ enter: busy ? null : () => void ((action) => action && onAction(action))(enter()), escape: () => back() })

  if (!me) return null

  const holdDialog: HoldDialogModel | null =
    hold && loaded
      ? {
          subject: loaded.row.batchNumber ? `${loaded.row.number} · ${loaded.row.batchNumber}` : loaded.row.number,
          reasons,
          picked: hold.picked,
          busy: hold.busy,
          problem: hold.problem,
          quantity: holdQuantity(loaded.read?.inspection.status === 'OPEN' ? { lotSize: loaded.read.inspection.plan.lotSize } : null, loaded.row),
        }
      : null

  const step: FinalStep = !can.view
    ? { kind: 'noPermission' }
    : problem
      ? { kind: 'problem', problem: problem.problem, code: problem.code ?? null }
      : stage.kind === 'pick' || !order
        ? rows === null
          ? { kind: 'loading' }
          : { kind: 'pick', rows: rows.map(benchRowModel), scanned }
        : stepOf(stage, order, loaded!)

  return (
    <FinalView
      model={{ frame, online, can: { record: can.record, release: can.release, labels: can.labels }, step, asOf, busy, pin, notice, hold: holdDialog, held }}
      onFrame={onFrame}
      onAction={(action) => void onAction(action)}
      camera={zxingCamera}
    />
  )
}

// ---- API → view model ------------------------------------------------------------------------------------------------------

const benchRowModel = (row: BenchRow): BenchRowModel => ({
  id: row.id,
  number: row.number,
  batchNumber: row.batchNumber,
  style: `${row.style.code} · ${row.style.name}`,
  dueDate: row.dueDate,
  pieces: row.pieces,
  finished: row.finished,
  released: row.released,
  open: row.openInspectionId !== null,
  assigned: benchAssignee(row.openInspection?.assigned),
  inspectionDueAt: row.openInspection?.dueAt ?? null,
  overdue: row.openInspection?.overdue ?? false,
})

export function orderModel(loaded: Loaded, context: { online: boolean; can: { record: boolean; release: boolean; labels: boolean }; locale?: 'it' | 'en' }): OrderModel {
  const { row, final, read } = loaded
  const made = final.maker.made
  const cells: CellModel[] = final.cells.map((cell) => ({
    id: cell.workOrderSizeId,
    label: `${cell.colourwayCode} ${cell.size}`,
    pieces: cell.pieces,
    released: cell.released,
    releasable: cell.releasable,
    labelsPrinted: cell.labelsPrinted,
    checks: cell.checks,
    secondPerson: cell.secondPersonReasons,
    held: releaseHeld({ online: context.online, mayRelease: context.can.release, made, checks: cell.checks, releasable: cell.releasable }),
    printLabels: labelsToPrint(cell.checks, context.can.labels),
  }))
  const openInspection = [...final.inspections].reverse().find((entry) => entry.status === 'OPEN') ?? null
  const passed = final.inspectionId !== null && cells.some((cell) => cell.releasable > 0)
  return {
    id: row.id,
    number: final.workOrder.number,
    batchNumber: final.workOrder.batchNumber,
    style: `${row.style.code} · ${row.style.name}`,
    status: final.workOrder.status,
    finished: row.finished,
    released: cells.reduce((sum, cell) => sum + cell.released, 0),
    made,
    rule: final.rule.rule,
    customerListed: final.rule.customerListed,
    documents: final.documents.map((document) => document.message),
    cells,
    inspections: final.inspections.map((entry) => ({ label: entry.label, status: entry.status })),
    open: openInspection ? { label: openInspection.label, yours: read?.yours ?? false } : null,
    main: mainAction({ open: openInspection ? { yours: read?.yours ?? false } : null, passed, made }, context.can),
    holds: final.holds.map((hold) => ({ id: hold.id, reason: reasonWord(hold, context.locale ?? 'it'), since: hold.placedAt, ncr: hold.ncrNumber })),
    holdHeld: holdHeld({ online: context.online, mayRecord: context.can.record, holds: final.holds.length }),
  }
}

/** A hold's reason in the screen's language (the API sends both). */
const reasonWord = (hold: Pick<BenchHold, 'reasonIt' | 'reasonEn'>, locale: 'it' | 'en'): string => (locale === 'en' ? hold.reasonEn : hold.reasonIt)

export function inspectionModel(read: InspectionRead): InspectionModel {
  const { inspection } = read
  return {
    id: inspection.id,
    label: inspection.label,
    plan: { ...inspection.plan },
    checklist: inspection.checklist,
    defects: inspection.defects.map((line) => ({ code: line.code, quantity: line.quantity })),
    result: inspection.computed.result,
    statementNeeded: read.statementNeeded,
  }
}

const jobModel = (job: PrintJob): JobModel => ({ id: job.id, status: job.status, copies: job.copies, detail: job.lastError })

function stepOf(stage: Stage, order: OrderModel, loaded: Loaded): FinalStep {
  const cellOf = (id: string) => order.cells.find((cell) => cell.id === id)
  switch (stage.kind) {
    case 'pick':
    case 'gate':
      return { kind: 'gate', order }
    case 'plan':
      return { kind: 'plan', order, plan: stage.plan, field: stage.field, maxLot: Math.max(1, Math.min(loaded.row.pieces, loaded.row.finished ?? 0)) }
    case 'checklist':
      return loaded.read ? { kind: 'checklist', order, inspection: inspectionModel(loaded.read), group: stage.group, failing: stage.failing } : { kind: 'gate', order }
    case 'sign':
      return loaded.read ? { kind: 'sign', order, inspection: inspectionModel(loaded.read), result: stage.result, statement: stage.statement } : { kind: 'gate', order }
    case 'release': {
      const cell = cellOf(stage.cellId)
      return cell ? { kind: 'release', order, cell, quantity: stage.quantity, signing: stage.signing, refused: stage.refused } : { kind: 'gate', order }
    }
    case 'labels': {
      const cell = cellOf(stage.cellId)
      return cell ? { kind: 'labels', order, cell, jobs: stage.jobs.map(jobModel), refused: stage.refused } : { kind: 'gate', order }
    }
    case 'done':
      return { kind: 'done', order, cell: stage.cell, quantity: stage.quantity, releaseNumber: stage.releaseNumber, secondPerson: stage.secondPerson }
  }
}
