'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useLiveChanges } from '../../../record-panels/live'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { homeTiles, modeOf } from '../../model'
import { readScan } from '../../scan/scan-model'
import { fetchListReasons, keptListReasons } from '../reasons/api'
import type { PickerReason } from '../reasons/model'
import type { ReasonPickerAction, ReasonPickerModel } from '../reasons/view/ReasonPicker'
import { queuedView } from '../shared/queued'
import { TASK_ROUTES, taskForScan } from '../routes'
import { fetchMyMessages, fetchStationHelp, fetchWorkList, keptMyMessages, keptStationHelp, keptWorkList } from './api'
import { arranged, changedRows, helpHeld, helpPayload, listChanged, materialTile, PUT_LAST_KEY, putLastIn, readPutLast, readSeen, SEEN_KEY, withPutLast, withSeen, type DispatchList, type MyMessages, type PutLast, type StationHelp } from './model'
import { MyWorkView, type MyWorkAction, type MyWorkCall, type MyWorkStep } from './view/MyWorkView'
// B-W2b-126: the repair queue (MES-132).
import { fetchRepairQueue, keptRepairQueue, scanOrKeep, type RepairScan } from './repair/api'
import { doneStill, outCounts, repairHeld, rowOfCode, withDone, type RepairDone, type RepairQueue } from './repair/model'
import type { RepairLineModel } from './repair/view/RepairViews'
// B-W2b-109: the inspector queue (QHS-068).
import { fetchInspectorQueue, fetchOfflinePack, keptInspectorQueue } from './inspections/api'
import { changedCount, codeOfRow, mayQueue, movesQueue, openHeld, queueChanged, queueFirst, taskOfKind, type InspectorQueue, type OpenHeld } from './inspections/model'

/** B-W2b-109: the offline pack is read once a visit (my open final inspections kept on the tablet, QHS-062). */
let packRead = false

/**
 * The live SCR-089 (`/floor/mywork`): the list to work from (the person's, else the station's queue: `fetchWorkList`) read on view, again when
 * the live channel says the floor's list may have moved (a plan published, a bundle reported, a hold placed or lifted,
 * a work order's status) or the stream comes back, every 30 s while in view, and on Try again. A fresher list never replaces the one on screen by
 * itself: it waits behind "List changed · Show". A scan here opens the station's job with the label (Home's scan router).
 * "I can't find it" → Put it last with a reason tile from the office's PAUSE list (`GET /reasons?list=PAUSE`), kept on
 * this tablet only (browser storage, wrapped: the office's plan never changes from the floor, Owner answer P3).
 *
 * B-W2b-71: "For your work" reads the open messages on the same beat; which ones were opened stays on this tablet (browser
 * storage, wrapped), never per person. Call for help: Material goes through the tablet's queue (kind `andon.call.send`): one
 * tap, online or not; who to call was read earlier in the visit, and the call says its two ticks.
 */

/** The live changes after which the station's list may differ (each a hint: the screen reads again). */
const MOVES = new Set(['planning.schedule_published', 'production.scan_recorded', 'quality.hold_placed', 'quality.hold_released', 'workorder.status_changed', 'dispatch.assignment_changed'])
/** B-W2b-126: the live changes after which the repair queue may differ (a repair scanned elsewhere, rework sent back or moved). */
const REPAIR_MOVES = new Set(['production.repair_scanned', 'production.rework_opened', 'production.rework_moved'])
/**
 * While the screen is in view it also reads again on this beat: the live rules of those events ask office permissions
 * (planning.view, workorders.view, quality.holds.view) that no floor role holds, so today they never reach a tablet
 * (named for the lead in the step's notes). One small read per tablet; a fresher list still waits for "Show".
 */
const REREAD_MS = 30_000
const PUT_LAST_LISTS = ['PAUSE']

function loadPutLast(): PutLast[] {
  try {
    return readPutLast(window.localStorage.getItem(PUT_LAST_KEY))
  } catch {
    return []
  }
}

function savePutLast(items: readonly PutLast[]): void {
  try {
    window.localStorage.setItem(PUT_LAST_KEY, JSON.stringify(items))
  } catch {
    // Private window or blocked storage: the mark lives for this visit only.
  }
}

function loadSeen(): string[] {
  try {
    return readSeen(window.localStorage.getItem(SEEN_KEY))
  } catch {
    return []
  }
}

function saveSeen(ids: readonly string[]): void {
  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(ids))
  } catch {
    // Private window or blocked storage: the marks live for this visit only.
  }
}

export function FloorMyWork() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.mywork', { showHome: true })
  const { me, api, online, sessionEnded, queue, queueSnapshot } = store
  const allowed = Boolean(me?.permissions.includes('floor.work'))
  // B-W2b-109: at an inspection bench the inspector queue is My work's list (design "Variants: … inspector queue").
  const inspector = allowed && mayQueue(me?.permissions ?? [])
  const inspectorFirst = inspector && queueFirst(me ? modeOf(me.device.station, me.device.mode) : null, me?.permissions ?? [])
  const [step, setStep] = useState<MyWorkStep>(allowed ? (inspectorFirst ? { kind: 'inspections' } : { kind: 'loading' }) : { kind: 'noPermission' })
  const [shown, setShown] = useState<DispatchList | null>(null)
  const [fresh, setFresh] = useState<DispatchList | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [problem, setProblem] = useState<'error' | 'offline' | null>(null)
  const [putLast, setPutLast] = useState<PutLast[]>([])
  const [cantFind, setCantFind] = useState<string | null>(null)
  const [putLastDone, setPutLastDone] = useState<{ slotId: string } | null>(null)
  const [messages, setMessages] = useState<MyMessages | null>(null)
  const [messagesAsOf, setMessagesAsOf] = useState<string | null>(null)
  const [messagesFailed, setMessagesFailed] = useState(false)
  const [seen, setSeen] = useState<string[]>([])
  const [help, setHelp] = useState<StationHelp | null>(null)
  const [helpProblem, setHelpProblem] = useState<'reading' | 'offline' | 'failed' | null>('reading')
  const [called, setCalled] = useState<{ id: string | null; number: string; seq: number } | null>(null)
  const shownRef = useRef<DispatchList | null>(null)
  shownRef.current = shown
  // B-W2b-126: the repair queue (production.repair), what this tablet scanned meanwhile, and the last scan's line.
  const canRepair = Boolean(me?.permissions.includes('production.repair')) && allowed
  const [repairRead, setRepairRead] = useState<RepairQueue | null>(null)
  const [repairAsOf, setRepairAsOf] = useState<string | null>(null)
  const [repairProblem, setRepairProblem] = useState<'offline' | 'error' | null>(null)
  const [repairDone, setRepairDone] = useState<RepairDone[]>([])
  const [repairSaid, setRepairSaid] = useState<(Omit<RepairLineModel, 'ticks'> & { clientEventId: string | null; ticks: RepairLineModel['ticks'] }) | null>(null)
  const [repairBusy, setRepairBusy] = useState(false)
  const deviceId = store.device?.device.id ?? null
  // B-W2b-109: my inspections — the queue on screen, a fresher one behind "List changed · Show", as of when, why not read.
  const [inspections, setInspections] = useState<InspectorQueue | null>(null)
  const [inspectionsFresh, setInspectionsFresh] = useState<InspectorQueue | null>(null)
  const [inspectionsAsOf, setInspectionsAsOf] = useState<string | null>(null)
  const [inspectionsProblem, setInspectionsProblem] = useState<'offline' | 'error' | null>(null)
  const inspectionsRef = useRef<InspectorQueue | null>(null)
  inspectionsRef.current = inspections

  useEffect(() => {
    setPutLast(loadPutLast())
    setSeen(loadSeen())
  }, [])

  /** My inspections: the first answer goes on screen; a later one that differs waits behind "List changed · Show". */
  const readInspections = useCallback(
    async (show: boolean) => {
      if (!inspector) return
      if (!packRead && online) {
        packRead = true
        void fetchOfflinePack(api)
      }
      const answer = await fetchInspectorQueue(api)
      if (answer.ok) {
        setInspectionsProblem(null)
        setInspectionsAsOf(null)
        if (show || inspectionsRef.current === null) {
          setInspections(answer.value)
          setInspectionsFresh(null)
        } else setInspectionsFresh(queueChanged(inspectionsRef.current, answer.value) ? answer.value : null)
        return
      }
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      const kept = keptInspectorQueue()
      if (kept && inspectionsRef.current === null) {
        setInspections(kept.value)
        setInspectionsAsOf(kept.asOf)
      } else if (inspectionsRef.current) setInspectionsAsOf((current) => current ?? inspectionsRef.current!.asOf)
      setInspectionsProblem(answer.problem.kind === 'offline' ? 'offline' : 'error')
    },
    [inspector, online, api, sessionEnded],
  )

  useEffect(() => {
    void readInspections(true)
  }, [readInspections])

  /** The open messages: a failed read keeps what this tablet read, with its time. */
  const readMessages = useCallback(async () => {
    if (!allowed) return
    const answer = await fetchMyMessages(api)
    if (answer.ok) {
      setMessages(answer.value)
      setMessagesAsOf(null)
      setMessagesFailed(false)
      return
    }
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    const kept = keptMyMessages()
    setMessages(kept?.value ?? null)
    setMessagesAsOf(kept?.asOf ?? null)
    setMessagesFailed(!kept)
  }, [allowed, api, sessionEnded])

  /** B-W2b-126: the repair queue; a failed read keeps what this tablet read, with its time. */
  const readRepair = useCallback(async () => {
    if (!canRepair) return
    const answer = await fetchRepairQueue(api)
    if (answer.ok) {
      setRepairRead(answer.value)
      setRepairAsOf(null)
      setRepairProblem(null)
      setRepairDone((current) => doneStill(current, answer.value))
      return
    }
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    const kept = keptRepairQueue()
    setRepairRead((current) => current ?? kept?.value ?? null)
    setRepairAsOf((current) => current ?? kept?.asOf ?? null)
    setRepairProblem(answer.problem.kind === 'offline' ? 'offline' : 'error')
  }, [canRepair, api, sessionEnded])

  /** Who to call for material: read once on view and when the dialog opens; offline it stays what this tablet read. */
  const readHelp = useCallback(async () => {
    if (!allowed) return
    const answer = await fetchStationHelp(api)
    if (answer.ok) {
      setHelp(answer.value)
      setHelpProblem(null)
      return
    }
    if (answer.problem.kind === 'signedOut') return void sessionEnded()
    const kept = keptStationHelp()
    setHelp(kept?.value ?? null)
    setHelpProblem(kept ? null : answer.problem.kind === 'offline' ? 'offline' : 'failed')
  }, [allowed, api, sessionEnded])

  /** Reads the queue: the first answer goes on screen; a later one that differs waits behind "List changed · Show". */
  const read = useCallback(
    async (show: boolean) => {
      if (!allowed) return
      void readMessages()
      void readRepair()
      const answer = await fetchWorkList(api)
      if (answer.ok) {
        setProblem(null)
        setAsOf(null)
        if (show || shownRef.current === null) {
          setShown(answer.value)
          setFresh(null)
        } else if (listChanged(shownRef.current, answer.value)) setFresh(answer.value)
        else setFresh(null)
        setStep((current) => (current.kind === 'loading' ? { kind: 'list' } : current))
        return
      }
      if (answer.problem.kind === 'signedOut') return void sessionEnded()
      // Offline, or the office did not answer: the queue this tablet read earlier, with its time.
      const kept = keptWorkList()
      if (kept && shownRef.current === null) {
        setShown(kept.value)
        setAsOf(kept.asOf)
      } else if (shownRef.current !== null) setAsOf((current) => current ?? shownRef.current!.asOf)
      setProblem(answer.problem.kind === 'offline' ? 'offline' : 'error')
      setStep((current) => (current.kind === 'loading' ? { kind: 'list' } : current))
    },
    [allowed, api, sessionEnded, readMessages, readRepair],
  )

  useEffect(() => {
    void read(true)
    void readHelp()
  }, [read, readHelp])

  // Back online: read again (the list shown stays until "Show").
  useEffect(() => {
    if (online && asOf) void read(false)
  }, [online, asOf, read])
  useEffect(() => {
    if (online && inspectionsAsOf) void readInspections(false)
  }, [online, inspectionsAsOf, readInspections])

  // In view: read again on the beat, and when the tablet comes back to this screen.
  useEffect(() => {
    if (!allowed || !online) return
    const again = () => {
      if (document.visibilityState === 'visible') {
        void read(false)
        void readInspections(false)
      }
    }
    const timer = window.setInterval(again, REREAD_MS)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', again)
    }
  }, [allowed, online, read, readInspections])

  useLiveChanges(
    {
      onChange: (change) => {
        if (MOVES.has(change.type)) void read(false)
        else if (REPAIR_MOVES.has(change.type)) void readRepair()
        else if (movesQueue(change.type)) void readInspections(false)
      },
      onReconnect: () => {
        void read(false)
        void readInspections(false)
      },
    },
    allowed && online,
  )

  // Marks of tasks no longer open drop off (the plan changed, the task got done).
  useEffect(() => {
    if (!shown) return
    setPutLast((current) => {
      const kept = putLastIn(shown, current)
      if (kept.length !== current.length) savePutLast(kept)
      return kept.length !== current.length ? kept : current
    })
  }, [shown])

  const openReasons = useCallback(
    async (slotId: string) => {
      const view = shown ? arranged(shown, putLast) : null
      const row = view ? [view.next, ...view.queue].find((entry) => entry?.entry.slotId === slotId) : null
      if (!row) return
      const subject = `${row.entry.workOrder.number} · Op ${row.entry.operation.seq} ${row.entry.operation.name}`
      const kept = keptListReasons(PUT_LAST_LISTS)
      const picker = (reasons: readonly PickerReason[], extra: Partial<ReasonPickerModel> = {}): MyWorkStep => ({ kind: 'reason', slotId, picker: { purpose: 'putLast', subject, reasons, value: null, ...extra } })
      if (!online) return setStep(kept ? picker(kept.value, { asOf: kept.asOf }) : picker([], { state: 'offline' }))
      setStep(picker(kept?.value ?? [], kept ? {} : { state: 'loading' }))
      const answer = await fetchListReasons(api, PUT_LAST_LISTS)
      if (!answer.ok) {
        if (answer.problem.kind === 'signedOut') return void sessionEnded()
        const again = keptListReasons(PUT_LAST_LISTS)
        return setStep((current) => (current.kind === 'reason' && current.slotId === slotId ? (again ? picker(again.value, { asOf: again.asOf, value: current.picker.value }) : picker([], { state: answer.problem.kind === 'offline' ? 'offline' : 'error' })) : current))
      }
      setStep((current) => (current.kind === 'reason' && current.slotId === slotId ? picker(answer.value, { value: current.picker.value ?? null }) : current))
    },
    [shown, putLast, online, api, sessionEnded],
  )

  // ---- Call for help: Material -------------------------------------------------------------------------------------------

  const sentCall = called?.id ? queuedView(queueSnapshot, called.id) : null
  const sentTicks = sentCall?.ticks ?? null
  // Once the office has it, the station's open call is what the dialog says next.
  useEffect(() => {
    if (sentTicks === 'recorded' || sentTicks === 'refused') void readHelp()
  }, [sentTicks, readHelp])

  const call: MyWorkCall | null = called ? { number: called.number, seq: called.seq, ticks: sentTicks ?? (called.id ? 'saved' : 'refused'), refusal: sentCall?.refusal?.code ?? null } : null
  const held = called?.id && (sentTicks === 'saved' || sentTicks === 'sending') ? 'waiting' : helpHeld({ help, problem: helpProblem })

  const sendHelp = async () => {
    const view = shown ? arranged(shown, putLast) : null
    const row = view ? [view.next, ...view.queue].find((entry) => entry?.entry.slotId === cantFind) : null
    const tile = materialTile(help)
    if (!row || !tile || held) return
    const about = { number: row.entry.workOrder.number, seq: row.entry.operation.seq }
    setCantFind(null)
    // The line that says where the call stands is on the list (a row's card has none).
    setStep({ kind: 'list' })
    try {
      const item = await queue.enqueue('andon.call.send', helpPayload(tile.type.id, row.entry))
      setCalled({ id: item.clientEventId, ...about })
      feedback('success')
    } catch {
      setCalled({ id: null, ...about })
      feedback('error')
    }
  }

  // ---- the repair queue (B-W2b-126) ---------------------------------------------------------------------------------------

  const repairShown = withDone(repairRead, repairDone, repairRead?.station ?? null)
  const saidTicks = repairSaid?.clientEventId ? (queuedView(queueSnapshot, repairSaid.clientEventId)?.ticks ?? repairSaid.ticks) : (repairSaid?.ticks ?? null)
  const saidRefusal = repairSaid?.clientEventId ? (queuedView(queueSnapshot, repairSaid.clientEventId)?.refusal?.code ?? repairSaid.refusal ?? null) : (repairSaid?.refusal ?? null)
  const repairLine: RepairLineModel | null = repairSaid && saidTicks ? { ...repairSaid, ticks: saidTicks, refusal: saidRefusal } : null

  /** One scan in or out, online first; kept on the tablet when the network fails (the row moves on screen at once). */
  const scanRepair = async (scan: RepairScan, label: string) => {
    const row = repairShown?.rows.find((entry) => entry.reworkId === scan.reworkId)
    if (!row || repairHeld(row) || repairBusy) return feedback('warning')
    setRepairBusy(true)
    const said = { code: label, step: scan.step, ...(scan.step === 'OUT' ? { good: scan.good ?? 0, scrap: scan.scrap ?? 0 } : {}) }
    try {
      const outcome = await scanOrKeep(api, queue, online, deviceId, scan)
      if (outcome.kept) {
        setRepairDone((current) => [...current.filter((entry) => !(entry.reworkId === scan.reworkId && entry.step === scan.step)), { reworkId: scan.reworkId, step: scan.step, at: new Date().toISOString(), clientEventId: outcome.kept.clientEventId }])
        setRepairSaid({ ...said, clientEventId: outcome.kept.clientEventId, ticks: 'saved' })
        feedback('success')
      } else if (outcome.answer.ok) {
        setRepairDone((current) => [...current, { reworkId: scan.reworkId, step: scan.step, at: outcome.answer.ok ? (outcome.answer.value.repair.repairInAt ?? new Date().toISOString()) : new Date().toISOString(), clientEventId: null }])
        setRepairSaid({ ...said, clientEventId: null, ticks: 'recorded' })
        feedback('success')
        void readRepair()
      } else {
        const problem = outcome.answer.problem
        if (problem.kind === 'signedOut') return void sessionEnded()
        setRepairSaid({ ...said, clientEventId: null, ticks: 'refused', refusal: problem.kind === 'refused' ? problem.code : null, words: problem.kind === 'refused' ? problem.message : null })
        feedback('error')
        void readRepair()
      }
      if (scan.step === 'OUT') setStep({ kind: 'repair' })
      else setStep({ kind: 'repairItem', reworkId: scan.reworkId })
    } finally {
      setRepairBusy(false)
    }
  }

  /** A label scanned on the repair screens: its row's scan in, or the scan out's question. */
  const onRepairScan = (code: string) => {
    const row = rowOfCode(repairShown, code)
    if (!row) {
      setRepairSaid({ code, step: 'IN', clientEventId: null, ticks: 'refused', refusal: 'NOT_IN_QUEUE' })
      return feedback('warning')
    }
    if (row.state === 'WAITING') return void scanRepair({ reworkId: row.reworkId, step: 'IN', code }, code)
    setRepairSaid(null)
    setStep({ kind: 'repairOut', reworkId: row.reworkId, code, good: null })
  }

  const repairOutWith = (good: number | null) => {
    if (step.kind !== 'repairOut') return
    const row = repairShown?.rows.find((entry) => entry.reworkId === step.reworkId)
    const counts = row ? outCounts(row, good) : null
    if (!row || !counts) return feedback('warning')
    void scanRepair({ reworkId: row.reworkId, step: 'OUT', ...(step.code ? { code: step.code } : {}), good: counts.good, scrap: counts.scrap }, row.bundle?.code ?? row.workOrder.number)
  }

  /** B-W2b-109: why "Inspect" cannot open each row here (no floor screen for it yet, no such tile, not mine to record). */
  const inspectionTiles = me ? homeTiles(modeOf(me.device.station, me.device.mode), me.permissions, me.notice.blocksScans, me.device.mode) : []
  const inspectionHeld: Record<string, OpenHeld> = Object.fromEntries((inspections?.rows ?? []).map((row) => [row.key, openHeld(row, inspectionTiles)]))

  const reasonDone = () => {
    if (step.kind !== 'reason') return
    const picked = step.picker.reasons.find((reason) => reason.id === step.picker.value)
    if (!picked) {
      feedback('warning')
      return
    }
    const next = withPutLast(putLast, { slotId: step.slotId, code: picked.code, labelIt: picked.labelIt, labelEn: picked.labelEn, at: new Date().toISOString() })
    setPutLast(next)
    savePutLast(next)
    setPutLastDone({ slotId: step.slotId })
    setStep({ kind: 'list' })
    feedback('success')
  }

  const onReason = (action: ReasonPickerAction) => {
    if (step.kind !== 'reason') return
    if (action.type === 'pick') return setStep({ ...step, picker: { ...step.picker, value: action.id } })
    if (action.type === 'retry') return void openReasons(step.slotId)
  }

  const onScan = async (code: string) => {
    if (!me) return
    if (step.kind === 'repair' || step.kind === 'repairItem' || step.kind === 'repairOut') return onRepairScan(code)
    const read = readScan(code, me.scanTag)
    const mode = modeOf(me.device.station, me.device.mode)
    const tiles = homeTiles(mode, me.permissions, me.notice.blocksScans, me.device.mode)
    // B-W2b-109 (QHS-065): on my inspections a code opens the final bench with it (a lot, a bundle, a serial, a carton …).
    if ((step.kind === 'inspections' || step.kind === 'inspection') && read.kind !== 'badge' && tiles.some((tile) => tile.key === 'final' && tile.held === null)) return store.openWith(TASK_ROUTES.final, read.code)
    const task = taskForScan(mode, read, tiles)
    if (task) return store.openWith(TASK_ROUTES[task], read.code)
    if (read.kind !== 'badge') return store.openScan(code)
    if (await store.switchTo(read.code)) feedback('error')
  }

  const back = () => {
    setCantFind(null)
    if (step.kind === 'repairOut') return setStep({ kind: 'repairItem', reworkId: step.reworkId })
    if (step.kind === 'repairItem') return setStep({ kind: 'repair' })
    if (step.kind === 'repair') setRepairSaid(null)
    if (step.kind === 'inspection') return setStep({ kind: 'inspections' })
    setStep(step.kind === 'message' ? { kind: 'messages' } : allowed ? { kind: 'list' } : { kind: 'noPermission' })
  }

  const openMessage = (id: string) => {
    const next = withSeen(seen, id)
    setSeen(next)
    saveSeen(next)
    setStep({ kind: 'message', id })
  }

  const onAction = (action: MyWorkAction) => {
    switch (action.type) {
      case 'scan':
        return void onScan(action.code)
      case 'open':
        setPutLastDone(null)
        return setStep({ kind: 'entry', slotId: action.slotId })
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'retry':
        setStep({ kind: 'loading' })
        return void read(true)
      case 'show':
        if (fresh) {
          setShown(fresh)
          setFresh(null)
          setAsOf(null)
        }
        return
      case 'cantFind':
        if (action.slotId && online) void readHelp()
        return setCantFind(action.slotId)
      case 'help':
        return void sendHelp()
      case 'messages':
        setPutLastDone(null)
        return setStep({ kind: 'messages' })
      case 'message':
        return openMessage(action.id)
      case 'putLast':
        setCantFind(null)
        return void openReasons(action.slotId)
      case 'reason':
        return onReason(action.action)
      case 'reasonDone':
        return reasonDone()
      // B-W2b-126: the repair queue.
      case 'repair':
        setPutLastDone(null)
        setRepairSaid(null)
        void readRepair()
        return setStep({ kind: 'repair' })
      case 'repairOpen':
        return setStep({ kind: 'repairItem', reworkId: action.reworkId })
      case 'repairStart': {
        const row = repairShown?.rows.find((entry) => entry.reworkId === action.reworkId)
        if (!row) return
        if (row.state === 'WAITING') return void scanRepair({ reworkId: row.reworkId, step: 'IN' }, row.workOrder.number)
        return setStep({ kind: 'repairOut', reworkId: row.reworkId, code: null, good: null })
      }
      case 'repairGood':
        return step.kind === 'repairOut' ? setStep({ ...step, good: action.value }) : undefined
      case 'repairAllGood':
        return repairOutWith(null)
      case 'repairConfirm':
        return step.kind === 'repairOut' ? repairOutWith(step.good) : undefined
      case 'repairRetry':
        return void readRepair()
      // B-W2b-109: my inspections.
      case 'inspections':
        setPutLastDone(null)
        void readInspections(false)
        return setStep({ kind: 'inspections' })
      case 'inspectionOpen':
        return setStep({ kind: 'inspection', key: action.key })
      case 'inspectionGo': {
        const row = inspections?.rows.find((entry) => entry.key === action.key)
        if (!row || !me) return
        if (inspectionHeld[row.key]) return feedback('warning')
        const task = taskOfKind(row.kind)
        const code = codeOfRow(row)
        if (!task) return feedback('warning')
        return code ? store.openWith(TASK_ROUTES[task], code) : router.push(TASK_ROUTES[task])
      }
      case 'inspectionsShow':
        if (inspectionsFresh) {
          setInspections(inspectionsFresh)
          setInspectionsFresh(null)
          setInspectionsAsOf(null)
        }
        return
      case 'inspectionsRetry':
        return void readInspections(true)
      case 'stationQueue':
        return setStep(shown ? { kind: 'list' } : { kind: 'loading' })
    }
  }

  useFloorKeys({
    enter: step.kind === 'reason' ? reasonDone : null,
    escape: cantFind !== null ? null : step.kind === 'entry' || step.kind === 'reason' || step.kind === 'messages' || step.kind === 'message' || step.kind === 'repair' || step.kind === 'repairItem' || step.kind === 'repairOut' || step.kind === 'inspection' || (step.kind === 'inspections' && !inspectorFirst) ? back : () => router.push('/floor'),
  })

  if (!me) return null

  return (
    <MyWorkView
      model={{
        frame,
        step,
        list: shown,
        putLast,
        problem,
        asOf,
        changed: fresh !== null,
        pending: fresh && shown ? changedRows(shown, fresh) : 0,
        cantFind,
        putLastDone,
        held: me.notice.blocksScans,
        mode: modeOf(me.device.station, me.device.mode),
        messages,
        seen,
        messagesAsOf: messagesAsOf ?? (!online && messages ? messages.asOf : null),
        messagesFailed,
        helpHeld: held,
        call,
        repair: canRepair ? repairShown : null,
        repairAsOf: repairAsOf ?? (!online && repairShown ? repairShown.asOf : null),
        repairProblem: repairShown ? null : repairProblem,
        repairLine,
        repairBusy,
        inspections: inspector
          ? {
              queue: inspections,
              asOf: inspectionsAsOf ?? (!online && inspections ? inspections.asOf : null),
              problem: inspections ? null : inspectionsProblem,
              changed: inspectionsFresh !== null,
              pending: inspectionsFresh && inspections ? changedCount(inspections, inspectionsFresh) : 0,
              first: inspectorFirst,
              held: inspectionHeld,
            }
          : null,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
