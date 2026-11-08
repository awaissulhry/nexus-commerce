'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useT } from '../../../lib/i18n/provider'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
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
// B-W2b-109: the bench on its plan (AQL sample, checks, measurements, serial or batch check, photo set) and scan to start.
import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import { useLiveChanges } from '../../../record-panels/live'
import { queuedView } from '../shared/queued'
import {
  decideOnPlan,
  fetchFinalDefects,
  keepModel,
  keptFinalDefects,
  keptModel,
  keptModelByNumber,
  openOnPlan,
  readPlans,
  readRecord,
  readSheet,
  recordOrKeep,
  scanChoices,
  scanToStart,
  uploadResultPhoto,
  type BenchPayload,
  type FinalDefect,
  type RecordModel,
  type Sheet,
} from './plan/api'
import {
  applyKept,
  classTakeBack,
  countPayload,
  defectLinesOf,
  defectsPayload,
  defectWords,
  failNote,
  failPayload,
  firstOpenSection,
  firstResult,
  isPlusKey,
  measureDraft,
  measureHeld,
  measurePayload,
  passPayload,
  photoTargets,
  sampleOf,
  signDecision,
  signHeld,
  slotResultPayload,
  startsAtBench,
  suggestedPlanOf,
  takeBackPayload,
  valuePayload,
  waitingWrites,
  identityAdd,
  identityRemove,
  countText,
  withDefectDelta,
  type BenchSection,
  type MeasureDraft,
} from './plan/model'
import type { BenchAction, BenchModel, ChoiceModel } from './plan/view/PlanBench'

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
  // B-W2b-109: open on the plan that applies; the bench on its plan; its signature; a code that leads to several.
  | { kind: 'planOpen'; planId: string; plan: { code: string; number: number; name: string }; lotSize: number; maxLot: number; sample: ReturnType<typeof sampleOf>; editing: boolean; key: string }
  | { kind: 'bench'; section: BenchSection; pick: BenchModel['pick']; value: BenchModel['value']; measure: MeasureDraft | null; photo: string | null }
  | { kind: 'benchSign'; decision: 'PASS' | 'FAIL'; statement: boolean; key: string }
  | { kind: 'choose'; code: string; choices: ChoiceModel[] }

interface Loaded {
  readonly row: BenchRow
  readonly final: FinalState
  /** The work order's OPEN inspection as this person reads it, or null. */
  readonly read: InspectionRead | null
  /** B-W2b-109: the bench sheet when the open inspection runs on a plan (B-W2b-97), else null. */
  readonly sheet?: Sheet | null
}

const benchStage = (sheet: Sheet, section?: BenchSection): Extract<Stage, { kind: 'bench' }> => ({ kind: 'bench', section: section ?? firstOpenSection(sheet), pick: null, value: null, measure: null, photo: null })

const memory = new AsOfMemory<Loaded>(30)
const listMemory = new AsOfMemory<BenchRow[]>(1)
/** B-W2a-75: Hold lot asks why from the tenant's HOLD list, in the floor's one reason picker (B-W2a-F6). */
const HOLD_LISTS = ['HOLD'] as const
const POLL_MS = 3_000

export function FloorFinal() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const t = useT('floor-final')
  const tp = useT('floor-final-plan')
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
  // B-W2b-109: the bench on its plan — the last write kept on the tablet, its busy flag, the FINAL defects, a photo just added.
  const [kept, setKept] = useState<string | null>(null)
  const [benchBusy, setBenchBusy] = useState(false)
  const [defects, setDefects] = useState<{ list: readonly FinalDefect[]; state: BenchModel['defects']['state'] }>({ list: [], state: 'loading' })
  const [photoAdded, setPhotoAdded] = useState<string | null>(null)
  const [sheetAsOf, setSheetAsOf] = useState<string | null>(null)
  const loadedRef = useRef<Loaded | null>(null)
  const stageRef = useRef<Stage>(stage)
  stageRef.current = stage
  const deviceId = store.device?.device.id ?? null
  /** B-W2b-109: scan to start, read through a ref so the scan handler always runs the latest one. */
  const startRef = useRef<(code: string, fromHome: boolean) => Promise<void>>(async () => undefined)

  loadedRef.current = loaded
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
      // B-W2b-109: an inspection on a plan reads its bench sheet (kept for the visit: offline, the bench goes on from it).
      const sheet = read?.ok && read.value.inspection.planVersion ? await readSheet(api, read.value.inspection.id, locale) : null
      if (read?.ok && sheet?.ok) keepModel(read.value.inspection.id, { final: read.value, sheet: sheet.value })
      const keptSheet = read?.ok && read.value.inspection.planVersion && !sheet?.ok ? (keptModel(read.value.inspection.id)?.value.sheet ?? null) : null
      const next: Loaded = { row, final: final.value, read: read?.ok ? read.value : null, sheet: sheet?.ok ? sheet.value : keptSheet }
      memory.keep(row.id, next)
      setLoaded(next)
      setAsOf(null)
      setSheetAsOf(keptSheet && read?.ok ? (keptModel(read.value.inspection.id)?.asOf ?? null) : null)
      return next
    },
    [api, sessionEnded, locale],
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
      // B-W2b-109 (QHS-065): a lot, a batch, a bundle, a garment's serial or a carton opens the right inspection, or starts it.
      if (startsAtBench(read)) return void startRef.current(read.code, fromHome)
      // Another kind of label (a hide, a place …): Scan anything opens its card.
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
      // B-W2b-109: not a work order of the bench: an inspection's number, a carton, a lot typed by hand … the queue's scan says.
      if (!row) return void startRef.current(read.code, fromHome)
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
    else if (stage.kind === 'benchSign') await runBenchDecide(stage)
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


  // ---- B-W2b-109: the bench on its plan ----------------------------------------------------------------------------------

  /** The record's model the office answered (W1's view and the sheet) on screen, kept for the visit. */
  const commitModel = (model: RecordModel) => {
    const current = loadedRef.current
    if (!current) return
    const next: Loaded = { ...current, read: model.final ?? current.read, sheet: model.sheet ?? current.sheet ?? null }
    if (model.final) keepModel(model.final.inspection.id, model)
    memory.keep(current.row.id, next)
    loadedRef.current = next
    setLoaded(next)
    setSheetAsOf(null)
  }

  /** The FINAL defects in the worker's language (a class's + asks which one; a failed check's reasons). */
  const readDefects = useCallback(async () => {
    const kept = keptFinalDefects(locale)
    if (kept) setDefects({ list: kept.value, state: 'ready' })
    if (!online) return void (kept ? undefined : setDefects({ list: [], state: 'offline' }))
    const answer = await fetchFinalDefects(api, locale)
    if (answer.ok) return setDefects({ list: answer.value, state: 'ready' })
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    if (!kept) setDefects({ list: [], state: answer.problem.kind === 'offline' ? 'offline' : 'error' })
  }, [api, locale, online, sessionEnded])

  /** Opens the bench on the loaded inspection's sheet (the first section not done). */
  const toBench = (sheet: Sheet, section?: BenchSection) => {
    setKept(null)
    setPhotoAdded(null)
    setStage(benchStage(sheet, section))
    void readDefects()
  }

  /**
   * One bench write ONLINE FIRST (B-W2b-106 `quality.final.record`): the office's answer is the record's model; a network
   * failure keeps the same payload on the tablet under the try's id and the sheet on screen moves at once (`applyKept`).
   */
  const benchWrite = async (payload: BenchPayload): Promise<RecordModel | 'kept' | null> => {
    const current = loadedRef.current
    if (!current?.sheet || benchBusy) return null
    setBenchBusy(true)
    setNotice(null)
    setPhotoAdded(null)
    try {
      const outcome = await recordOrKeep(api, store.queue, online, deviceId, payload)
      if (outcome.kept) {
        const now = loadedRef.current ?? current
        const sheet = applyKept(now.sheet ?? current.sheet, payload, new Date().toISOString())
        const read = payload.what === 'DEFECTS' && now.read ? { ...now.read, inspection: { ...now.read.inspection, defects: payload.defects.map((line, index) => ({ id: `kept:${index}`, defectClass: line.defectClass, code: line.code, description: null, quantity: line.quantity, workOrderSizeId: null, note: null })) } } : now.read
        const next: Loaded = { ...now, read, sheet }
        loadedRef.current = next
        setLoaded(next)
        setKept(outcome.kept.clientEventId)
        feedback('success')
        return 'kept'
      }
      const answer = outcome.answer
      if (answer.ok) {
        commitModel(answer.value.model)
        setKept(null)
        feedback('success')
        return answer.value.model
      }
      ended(answer)
      feedback('error')
      setNotice(answer.problem)
      if (answer.problem.kind === 'conflict' || answer.problem.kind === 'refused') await reload()
      return null
    } finally {
      setBenchBusy(false)
    }
  }

  /** A photo onto a result (online only): announced, PUT to the store, confirmed; then the sheet again. */
  const addPhoto = async (inspectionId: string, resultId: string, photo: CapturedPhoto, label: string): Promise<boolean> => {
    setBenchBusy(true)
    const blob = photo.marked ?? photo.photo
    const answer = await uploadResultPhoto(api, inspectionId, resultId, blob, `${label}.jpg`.replace(/[^\w.-]+/g, '-'))
    setBenchBusy(false)
    if (!answer.ok) {
      ended(answer)
      feedback('error')
      setNotice(answer.problem)
      return false
    }
    const sheet = await readSheet(api, inspectionId, locale)
    if (sheet.ok) commitModel({ final: loadedRef.current?.read ?? null, sheet: sheet.value })
    feedback('success')
    setPhotoAdded(label)
    return true
  }

  /** The first unit's result of a check in a sheet (a slot's photo hangs on it). */
  const resultIdOf = (sheet: Sheet | null | undefined, checkCode: string): string | null => {
    const check = sheet?.checks.find((entry) => entry.code === checkCode)
    return check ? (firstResult(check)?.id ?? null) : null
  }

  const onBench = async (action: BenchAction) => {
    const current = loadedRef.current
    const sheet = current?.sheet
    if (stage.kind !== 'bench' || !current || !sheet) return
    const id = sheet.inspection.id
    const lines = defectLinesOf(current.read?.inspection.defects ?? [])
    const set = (patch: Partial<Extract<Stage, { kind: 'bench' }>>) => setStage((now) => (now.kind === 'bench' ? { ...now, ...patch } : now))
    switch (action.type) {
      case 'section':
        setPhotoAdded(null)
        return set({ section: action.section, pick: null, value: null, measure: null, photo: null })
      case 'close':
        setNotice(null)
        return set({ pick: null, value: null, measure: null, photo: null })
      case 'count':
        if (action.add !== 0) await benchWrite(countPayload(id, action.add))
        return
      case 'classAdd':
        if (defects.state !== 'ready') void readDefects()
        return set({ pick: { kind: 'add', defectClass: action.defectClass } })
      case 'classRemove': {
        const back = classTakeBack(lines, action.defectClass)
        if (back.kind === 'one') return void benchWrite(defectsPayload(id, withDefectDelta(lines, back.line, -1)))
        if (back.kind === 'pick') return set({ pick: { kind: 'remove', defectClass: action.defectClass } })
        return
      }
      case 'pick': {
        if (!stage.pick) return
        const saved = await benchWrite(defectsPayload(id, withDefectDelta(lines, { defectClass: stage.pick.defectClass, code: action.code }, stage.pick.kind === 'add' ? 1 : -1)))
        if (saved) set({ pick: null })
        return
      }
      case 'pickClose':
        return set({ pick: null })
      case 'line':
        return void benchWrite(defectsPayload(id, withDefectDelta(lines, { defectClass: action.defectClass, code: action.code }, action.delta)))
      case 'pass':
        if (action.codes.length > 0) await benchWrite(passPayload(id, action.codes))
        return
      case 'fail': {
        const words = action.reasonId ? defectWords(defects.list, action.reasonId) : tp('checks.failNote')
        const saved = await benchWrite(failPayload(id, action.code, failNote(words, action.reasonId ?? null)))
        // The photo taken with the fail goes onto the result the office just made (online only; offline it waits in Photos).
        if (saved && saved !== 'kept' && action.photo) {
          const resultId = resultIdOf(saved.sheet, action.code)
          const check = saved.sheet?.checks.find((entry) => entry.code === action.code)
          if (resultId) await addPhoto(id, resultId, action.photo as CapturedPhoto, check?.code ?? action.code)
        }
        return
      }
      case 'valueOpen': {
        const check = sheet.checks.find((entry) => entry.code === action.code)
        const result = check ? firstResult(check) : null
        return set({ value: { code: action.code, value: check?.type === 'COUNT' && result?.value ? Number(result.value) : null, choice: check?.type === 'CHOICE' ? (result?.value ?? null) : null } })
      }
      case 'valueNumber':
        return stage.value ? set({ value: { ...stage.value, value: action.value } }) : undefined
      case 'valueChoice':
        return stage.value ? set({ value: { ...stage.value, choice: action.value } }) : undefined
      case 'valueSave': {
        if (!stage.value) return
        const check = sheet.checks.find((entry) => entry.code === stage.value!.code)
        const text = check?.type === 'CHOICE' ? stage.value.choice : stage.value.value === null ? null : countText(stage.value.value)
        if (!check || text === null) return feedback('warning')
        const saved = await benchWrite(valuePayload(id, check.code, text, action.outcome, tp('checks.failValue', { value: text })))
        if (saved) set({ value: null })
        return
      }
      case 'measureOpen': {
        const point = sheet.chart.points.find((entry) => entry.pointCode === action.pointCode)
        return point ? set({ measure: measureDraft(point, sheet.counter.sampleSize, sizesOf(current)) }) : undefined
      }
      case 'measureField':
        return stage.measure ? set({ measure: { ...stage.measure, field: action.field } }) : undefined
      case 'measureSize':
        return stage.measure ? set({ measure: { ...stage.measure, size: action.size } }) : undefined
      case 'measureNumber':
        return stage.measure ? set({ measure: { ...stage.measure, [stage.measure.field]: action.value } }) : undefined
      case 'measureSave': {
        const draft = stage.measure
        const point = draft ? sheet.chart.points.find((entry) => entry.pointCode === draft.pointCode) : null
        if (!draft || !point || measureHeld(point, draft)) return feedback('warning')
        const saved = await benchWrite(measurePayload(id, point, draft))
        if (!saved) return
        // The next unit of the same point, the typed nominal and tolerance kept (the inspector measures garment after garment).
        const after = loadedRef.current?.sheet?.chart.points.find((entry) => entry.pointCode === draft.pointCode) ?? point
        const next = measureDraft(after, sheet.counter.sampleSize, sizesOf(current))
        return set({ measure: { ...next, size: draft.size, nominal: draft.nominal, tolerance: draft.tolerance, field: 'value' } })
      }
      case 'measureTakeBack': {
        const point = sheet.chart.points.find((entry) => entry.pointCode === action.pointCode)
        if (point) await benchWrite(takeBackPayload(id, point, { size: action.size, sampleIndex: action.sampleIndex }))
        return
      }
      case 'serial':
        await benchWrite(identityAdd(id, action.code))
        return
      case 'serialRemove':
        await benchWrite(identityRemove(id, action.code))
        return
      case 'photoOpen':
        setPhotoAdded(null)
        return set({ photo: action.key })
      case 'photoTaken': {
        const target = stage.photo ? photoTargets(sheet, locale).find((entry) => entry.key === stage.photo) : null
        if (!target || !online) return feedback('warning')
        let resultId = target.resultId
        // A slot's photo hangs on its PHOTO check's result: recorded first (online), then the photo goes onto it.
        if (!resultId && target.kind === 'slot') {
          const saved = await benchWrite(slotResultPayload(id, target.checkCode))
          if (!saved || saved === 'kept') return
          resultId = resultIdOf(saved.sheet, target.checkCode)
        }
        if (!resultId) return feedback('warning')
        if (await addPhoto(id, resultId, action.photo, target.label)) set({ photo: null })
        return
      }
      case 'retryDefects':
        return void readDefects()
    }
  }

  /** The work order's sizes (a point of measure names its size when there are several). */
  const sizesOf = (current: Loaded): string[] => [...new Set(current.final.cells.map((cell) => cell.size))]

  /** Scan to start (QHS-065, B-W2b-106): the code opens the right inspection, or starts it on its plan; CHOOSE asks which. */
  const startFrom = async (code: string, fromHome: boolean) => {
    if (!online) {
      // Offline (QHS-062): an open inspection this tablet kept (the offline pack, or read in this visit) opens from what it holds.
      const kept = keptModelByNumber(code)
      const read = kept?.value.final ?? null
      const row = read ? (listMemory.get('rows')?.value.find((entry) => entry.id === read.workOrder.id) ?? null) : null
      const order = row ? memory.get(row.id) : null
      if (kept && read && order) {
        const next: Loaded = { ...order.value, read, sheet: kept.value.sheet }
        loadedRef.current = next
        setLoaded(next)
        setAsOf(order.asOf)
        setSheetAsOf(kept.asOf)
        if (kept.value.sheet) return toBench(kept.value.sheet)
        return setStage({ kind: 'checklist', group: nextGroup(read.inspection.checklist), failing: null })
      }
      feedback('warning')
      return setProblem({ problem: { kind: 'offline' }, code })
    }
    setBusy(true)
    setProblem(null)
    setNotice(null)
    const answer = await scanToStart(api, code, freshKey())
    if (!answer.ok) {
      setBusy(false)
      ended(answer)
      if (answer.problem.kind === 'refused' && answer.problem.code === 'CHOOSE') {
        const choices = await scanChoices(api, code)
        if (choices.ok) {
          const open = choices.value.choices.filter((choice): choice is typeof choice & { id: string } => choice.id !== null)
          feedback('warning')
          return setStage({ kind: 'choose', code, choices: open.map((choice) => ({ id: choice.id, number: choice.number, words: locale === 'it' ? choice.words.it : choice.words.en })) })
        }
      }
      if (answer.problem.kind === 'notFound' && fromHome) return store.openScan(code)
      feedback('error')
      if (answer.problem.kind === 'notFound') return setScanned({ code, why: 'notFound' })
      return setProblem({ problem: answer.problem, code })
    }
    await openStarted(answer.value.model, code)
  }
  startRef.current = startFrom

  /** An inspection the queue's scan opened or started: its work order on the bench, then the bench on its plan. */
  const openStarted = async (model: RecordModel, code: string) => {
    const read = model.final
    if (!read) {
      setBusy(false)
      return setScanned({ code, why: 'notFound' })
    }
    const list = await listBench(api, read.workOrder.number)
    const row = list.ok ? (list.value.workOrders.find((entry) => entry.id === read.workOrder.id) ?? null) : null
    const final = row ? await readFinal(api, row.id) : null
    setBusy(false)
    if (!row || !final?.ok) {
      if (list.ok || !final) feedback('error')
      return setProblem({ problem: final && !final.ok ? final.problem : list.ok ? { kind: 'notFound' } : list.problem, code })
    }
    const next: Loaded = { row, final: final.value, read, sheet: model.sheet }
    keepModel(read.inspection.id, model)
    memory.keep(row.id, next)
    loadedRef.current = next
    setLoaded(next)
    setSheetAsOf(null)
    setScanned(null)
    feedback('success')
    if (model.sheet) return toBench(model.sheet)
    setStage({ kind: 'checklist', group: nextGroup(read.inspection.checklist), failing: null })
  }

  /** A choice of a code that leads to several open inspections. */
  const openChosen = async (inspectionId: string, code: string) => {
    setBusy(true)
    const read = await readRecord(api, inspectionId)
    const sheet = read.ok && read.value.inspection.planVersion ? await readSheet(api, inspectionId, locale) : null
    if (!read.ok) {
      setBusy(false)
      ended(read)
      return setProblem({ problem: read.problem, code })
    }
    await openStarted({ final: read.value, sheet: sheet?.ok ? sheet.value : null }, code)
  }

  /** Start: the plan that applies (B-W2b-97), with the sample of the lot from the API; none applies: W1's typed plan. */
  const startOnPlan = async (current: Loaded): Promise<boolean> => {
    if (!online) return false
    const lotSize = suggestedLot(current.row)
    setBusy(true)
    const answer = await readPlans(api, current.row.id, lotSize)
    setBusy(false)
    if (!answer.ok) {
      ended(answer)
      return false
    }
    const plan = suggestedPlanOf(answer.value)
    if (!plan?.approved) return false
    setStage({ kind: 'planOpen', planId: plan.id, plan: { code: plan.code, number: plan.approved.number, name: plan.name }, lotSize, maxLot: Math.max(1, Math.min(current.row.pieces, current.row.finished ?? 0) - current.row.released), sample: sampleOf(answer.value), editing: false, key: freshKey() })
    return true
  }

  /** The lot changed: its sample is read again (the API's, never computed here); the last answer for this lot wins. */
  const planLot = async (value: number) => {
    if (stage.kind !== 'planOpen' || !loaded) return
    const lotSize = Math.max(1, Math.min(stage.maxLot, Math.round(value)))
    setStage({ ...stage, lotSize, sample: null })
    const answer = await readPlans(api, loaded.row.id, lotSize)
    setStage((now) => (now.kind === 'planOpen' && now.lotSize === lotSize ? { ...now, sample: answer.ok ? sampleOf(answer.value) : null } : now))
  }

  const openOnPlanNow = async () => {
    if (stage.kind !== 'planOpen' || !loaded || !online || busy) return
    setBusy(true)
    setNotice(null)
    const opened = await openOnPlan(api, { workOrderId: loaded.row.id, lotSize: stage.lotSize, planId: stage.planId }, stage.key)
    if (!opened.ok) {
      setBusy(false)
      ended(opened)
      feedback('error')
      return setNotice(opened.problem)
    }
    const [read, sheet] = await Promise.all([readRecord(api, opened.value.inspection.id), readSheet(api, opened.value.inspection.id, locale)])
    const final = await readFinal(api, loaded.row.id)
    setBusy(false)
    if (!read.ok || !sheet.ok) {
      feedback('error')
      return setNotice(!read.ok ? read.problem : !sheet.ok ? sheet.problem : null)
    }
    commitModel({ final: read.value, sheet: sheet.value })
    if (final.ok && loadedRef.current) {
      const next = { ...loadedRef.current, final: final.value }
      loadedRef.current = next
      setLoaded(next)
    }
    feedback('success')
    toBench(sheet.value)
  }

  /** Signs the result on a plan with the PIN: the sheet read first (its version), never while answers wait on the tablet. */
  const runBenchDecide = async (signing: Extract<Stage, { kind: 'benchSign' }>) => {
    const current = loadedRef.current
    if (!current?.sheet || !online) return
    setBusy(true)
    setNotice(null)
    const sheet = await readSheet(api, current.sheet.inspection.id, locale)
    if (!sheet.ok) {
      setBusy(false)
      ended(sheet)
      return setNotice(sheet.problem)
    }
    const answer = await decideOnPlan(api, sheet.value.inspection.id, { version: sheet.value.inspection.version, result: signing.decision, ...(current.read?.statementNeeded ? { notMakerStatement: signing.statement } : {}) }, signing.key)
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
    commitModel({ final: current.read, sheet: sheet.value })
  }

  // Live (design "Another inspector opens the same lot"; two tablets add up): a write elsewhere on this inspection reads the sheet again.
  const benchId = stage.kind === 'bench' ? (loaded?.sheet?.inspection.id ?? null) : null
  useLiveChanges(
    {
      onChange: (change) => {
        if (change.type !== 'final_inspection.recorded' || !benchId || change.fields.inspectionId !== benchId || benchBusy) return
        void readSheet(api, benchId, locale).then((answer) => (answer.ok ? commitModel({ final: loadedRef.current?.read ?? null, sheet: answer.value }) : undefined))
      },
      onReconnect: () => {
        if (benchId) void readSheet(api, benchId, locale).then((answer) => (answer.ok ? commitModel({ final: loadedRef.current?.read ?? null, sheet: answer.value }) : undefined))
      },
    },
    Boolean(benchId) && online,
  )

  const onBenchRef = useRef(onBench)
  onBenchRef.current = onBench
  // "+" counts one piece on the AQL counter (design floor.final keyboard), never while a field or the PIN pad has the focus.
  useEffect(() => {
    if (stage.kind !== 'bench' || stage.section !== 'aql' || stage.pick) return
    const onKey = (event: KeyboardEvent) => {
      if (!isPlusKey(event.key) || event.ctrlKey || event.metaKey || event.altKey) return
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active?.closest('[aria-modal="true"]')) return
      const sheet = loadedRef.current?.sheet
      if (!sheet || !sheet.may.record || sheet.counter.inspected >= sheet.counter.sampleSize) return
      event.preventDefault()
      void onBenchRef.current({ type: 'count', add: 1 })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [stage])

  // The last write kept on this tablet: where it stands (saved here → recorded by the office, or refused when sent).
  const keptView = kept ? queuedView(store.queueSnapshot, kept) : null

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
      // B-W2b-109
      case 'planOpen':
        return setStage({ kind: 'gate' })
      case 'bench':
        if (stage.pick || stage.value || stage.measure || stage.photo) return setStage({ ...stage, pick: null, value: null, measure: null, photo: null })
        setKept(null)
        return setStage({ kind: 'gate' })
      case 'benchSign':
        return loaded?.sheet ? setStage(benchStage(loaded.sheet)) : setStage({ kind: 'gate' })
      case 'choose':
        return setStage({ kind: 'pick' })
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
        // B-W2b-109: an inspection on its plan continues on the bench; a new one opens on the plan that applies (none: W1's).
        if (order.main === 'continue' && loaded.sheet) return toBench(loaded.sheet)
        // On a plan without its sheet (not read, none kept): W1's checklist would be refused (PLAN_CHECKS); say why instead.
        if (order.main === 'continue' && inspection?.planVersion) return setProblem({ problem: { kind: online ? 'unavailable' : 'offline' }, code: inspection.inspectionNumber ?? loaded.row.number })
        if (order.main === 'continue' && inspection) return setStage({ kind: 'checklist', group: nextGroup(inspection.checklist), failing: null })
        if (order.main === 'start' && (await startOnPlan(loaded))) return
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
        if (stage.kind === 'benchSign') return setStage({ ...stage, statement: action.value })
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
      // B-W2b-109: the bench on its plan.
      case 'bench':
        return onBench(action.action)
      case 'plan-lot':
        return planLot(action.value)
      case 'plan-edit':
        return stage.kind === 'planOpen' ? setStage({ ...stage, editing: action.editing }) : undefined
      case 'open-on-plan':
        return openOnPlanNow()
      case 'bench-sign': {
        const sheet = loaded?.sheet
        if (!sheet || stage.kind !== 'bench' || !online) return
        const decision = signDecision(sheet)
        if (signHeld(sheet, decision).length > 0 || waitingWrites(store.queueSnapshot.items, sheet.inspection.id) > 0 || !sheet.may.record) return feedback('warning')
        const signing: Extract<Stage, { kind: 'benchSign' }> = { kind: 'benchSign', decision, statement: false, key: freshKey() }
        setNotice(null)
        setPin(null)
        // The PIN is the signature (design floor.final "Release → 6 PIN digits"; B-W2b-105): always asked on its own step, never a
        // silent sign inside the step-up window.
        return setStage(signing)
      }
      case 'choose': {
        if (stage.kind !== 'choose') return
        return openChosen(action.id, stage.code)
      }
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
      case 'planOpen':
        return stage.editing ? null : { type: 'open-on-plan' }
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
      : stage.kind === 'choose'
        ? { kind: 'choose', code: stage.code, choices: stage.choices }
        : stage.kind === 'pick' || !order
          ? rows === null
            ? { kind: 'loading' }
            : { kind: 'pick', rows: rows.map(benchRowModel), scanned }
          : stepOf(stage, order, loaded!, {
              defects,
              kept: keptView ? { ticks: keptView.ticks, refusal: keptView.refusal?.code ?? null } : null,
              busy: benchBusy,
              asOf: sheetAsOf ?? (asOf && loaded?.sheet ? asOf : null),
              waiting: loaded?.sheet ? waitingWrites(store.queueSnapshot.items, loaded.sheet.inspection.id) : 0,
              photoAdded,
              signer: me.worker.displayName,
            })

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

/** B-W2b-109: what the bench on its plan shows beside the sheet (the container's state). */
interface BenchContext {
  readonly defects: BenchModel['defects']
  readonly kept: BenchModel['kept']
  readonly busy: boolean
  readonly asOf: string | null
  readonly waiting: number
  readonly photoAdded: string | null
  /** The signer's name on the PIN block (the person signed in: their own name only). */
  readonly signer: string
}

function stepOf(stage: Stage, order: OrderModel, loaded: Loaded, bench: BenchContext): FinalStep {
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
    // B-W2b-109
    case 'planOpen':
      return { kind: 'planOpen', order, open: { plan: stage.plan, lotSize: stage.lotSize, maxLot: stage.maxLot, sample: stage.sample, editing: stage.editing } }
    case 'bench':
      return loaded.sheet
        ? {
            kind: 'bench',
            order,
            bench: {
              sheet: loaded.sheet,
              section: stage.section,
              lines: defectLinesOf(loaded.read?.inspection.defects ?? []),
              defects: bench.defects,
              pick: stage.pick,
              value: stage.value,
              measure: stage.measure,
              photo: stage.photo,
              sizes: [...new Set(loaded.final.cells.map((cell) => cell.size))],
              kept: bench.kept,
              photoAdded: bench.photoAdded,
              busy: bench.busy,
              asOf: bench.asOf,
              waiting: bench.waiting,
            },
          }
        : { kind: 'gate', order }
    case 'benchSign':
      return loaded.sheet ? { kind: 'benchSign', order, sheet: loaded.sheet, decision: stage.decision, statementNeeded: loaded.read?.statementNeeded ?? false, statement: stage.statement, signer: bench.signer } : { kind: 'gate', order }
    case 'choose':
      return { kind: 'gate', order }
  }
}
