'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { PlanningCard, PlanningMove } from '@nexus/ui/patterns/planning-board/index'
import { isApiError } from '../../../lib/api/errors'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { BOARD_KIT_NAMESPACE } from '../../_shared/planning-board/words'
import { getBarDetail, getBoard, getPublishPreview, listPlanningSites, listVersions, moveSlot, placeByDueDate, placeSlot, publishPlan, removeSlot, type Board, type PlanningSite, type PublishRange } from './api'
import {
  controlsOf,
  drawBoard,
  laneKeyOf,
  NAMESPACE,
  nextFreePlace,
  overFromIssues,
  overFromMove,
  planMove,
  queryOf,
  readProblemOf,
  refusalOf,
  refusalWords,
  windowFrom,
  workOrderOfTrayCard,
  type BoardControls,
  type MovePlan,
  type OverDay,
  type ProblemRow,
  type Refusal,
  type Words,
} from './model'
import type { BoardDepth, BoardDialog, BoardViewModel, ChangesState, DropChoice, Loaded, PublishRangeKind, SaveState } from './view-model'
import { BoardView } from './view/BoardView'
// B-W2b-263: a drop held on a pre-production gate asks "Start before the gate?" (Time & action's dialog).
import { useStartBeforeGate } from '../milestones/use-start-before'
// B-W2b-337: the board in depth (pins, the floor, workshops as lanes, what-if, the change log with undo, day sheets, export).
import { DEPTH_NAMESPACE as ALLOCATION_DEPTH_NAMESPACE, kitProblemOf, switchRefusalOf, switchRefusalWords, holdWords, workshopOf, type Words as AllocationWords } from '../allocation/depth/model'
import { getAllocationWorkshops, getWorkOrderWorkshops, type OutsideAnswer } from '../allocation/depth/api'
import { getSubcontractorCapacity } from '../capacity/depth/api'
import {
  applyWhatIf,
  createWhatIf,
  discardWhatIf,
  getChanges,
  getDaySheetPaper,
  getDaySheetPdf,
  getKitTimingAt,
  getMaterial,
  getWhatIf,
  listWhatIfs,
  pinSlot,
  pinWorkOrder,
  rescheduleBacklog,
  sendOutsideAt,
  setWhatIfMoves,
  undoChange,
  type ChangeEntry,
  type MaterialAnswer,
  type SheetQuery,
  type WhatIf,
} from './depth/api'
import {
  applyConflicts,
  DEPTH_NAMESPACE,
  EXPORT_COLUMNS,
  exportQuery,
  kindsOf,
  materialAsk,
  myLatestUndoable,
  plannersOf,
  sheetIds,
  whatIfBoard,
  whatIfInputs,
  withTriedMove,
  workshopDropOf,
  type DepthProblemRow,
} from './depth/model'
import { useBoardExport } from './depth/use-export'
import { VersionTab } from './depth/VersionTab'

/**
 * `/w/<company>/planning/board` (SCR-122; Planning › Planning board, planning.view). The company's planning sites
 * (`?site=`, else the first), the board of the window (`?view=` `?zoom=` `?from=` and the filters, all in the address),
 * live (another planner's move, a publish, a calendar or a work order reads the board again), and every write ONE at a
 * time, never optimistic: a move is sent with the slot's version and the bar stays "Saving" until the API answered and
 * the board was read again; a 409 says who moved it and when, a drop over capacity asks "Keep with a reason" first.
 *
 * B-W2b-337 (the board in depth): `?version=<id>` is the published version tab (read-only); `?whatif=<id>` the planner's
 * private what-if (moves tried on it, never on the working plan, until Apply). A drop earlier than the material asks Snap /
 * Keep my date; a drop on a workshop opens Move to a subcontractor; P pins; ⌘Z undoes the planner's newest change of the log.
 */
export function BoardPage() {
  return (
    <WithMessages namespaces={[NAMESPACE, BOARD_KIT_NAMESPACE, DEPTH_NAMESPACE, ALLOCATION_DEPTH_NAMESPACE, 'lists', 'buying']}>
      <BoardRoute />
    </WithMessages>
  )
}

function BoardRoute() {
  const params = useSearchParams()
  const version = params?.get('version') ?? null
  return version ? <VersionTab versionId={version} /> : <BoardContainer />
}

const EMPTY_CHANGES: ChangesState = { read: { status: 'loading' }, since: 'PUBLISHED', kinds: [], planner: null, planners: [] }

function BoardContainer() {
  const t = useT(NAMESPACE)
  const td = useT(DEPTH_NAMESPACE)
  const ta = useT(ALLOCATION_DEPTH_NAMESPACE)
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const gate = useStartBeforeGate(api, session.company?.id ?? null) // B-W2b-263
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const controls = useMemo(() => controlsOf(new URLSearchParams(query)), [query])
  const prefix = pathname.replace(/\/planning\/board\/?$/, '')
  const may = useMemo(
    () => ({
      pin: session.permissions.includes('planning.schedule.pin'),
      outsource: session.permissions.includes('planning.subcontract.outsource'),
      order: session.permissions.includes('purchasing.subcontract.manage'),
      export: true,
    }),
    [session.permissions],
  )

  const [sites, setSites] = useState<Loaded<PlanningSite[]>>({ status: 'loading' })
  const [read, setRead] = useState<Loaded<Board>>({ status: 'loading' })
  const [save, setSave] = useState<SaveState>({ state: 'idle' })
  const [dialog, setDialog] = useState<BoardDialog | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [focus, setFocus] = useState<BoardViewModel['focus']>(null)
  const [online, setOnline] = useState(true)
  // B-W2b-337
  const [whatIf, setWhatIf] = useState<BoardDepth['whatIf']>(null)
  const [changes, setChanges] = useState<ChangesState>(EMPTY_CHANGES)
  const [workshops, setWorkshops] = useState<BoardDepth['workshops']>({ status: 'loading' })
  const [subcontractors, setSubcontractors] = useState<BoardDepth['subcontractors']>({ status: 'loading' })
  const boardRef = useRef<Board | null>(null)
  const controlsRef = useRef(controls)
  controlsRef.current = controls
  const readId = useRef(0)
  const knownVersion = useRef<number | null>(null)
  const dropAnswer = useRef<((choice: DropChoice) => void) | null>(null)
  const materialAnswer = useRef<((choice: 'snap' | 'keep' | 'cancel') => void) | null>(null)
  const defaultRange = useRef<{ from: string; to: string } | null>(null)
  const scenarioRef = useRef<WhatIf | null>(null)
  const changesRef = useRef(changes)
  changesRef.current = changes
  const lastUndone = useRef<ChangeEntry | null>(null)

  const site = sites.status === 'ready' ? (sites.value.find((entry) => entry.id === controls.site) ?? sites.value[0] ?? null) : null
  const siteId = site?.id ?? null
  const timeZone = site?.timeZone ?? 'Europe/Rome'
  const words = useMemo<Words>(() => ({ t, locale, timeZone, td }), [t, locale, timeZone, td])
  const aw = useMemo<AllocationWords>(() => ({ t: ta, locale }), [ta, locale])
  const exporter = useBoardExport(
    td('export.fileTitle'),
    useCallback((column: (typeof EXPORT_COLUMNS)[number]) => td(`export.column.${column}`), [td]),
  )

  const setControls = useCallback(
    (next: Partial<BoardControls>) => {
      const qs = queryOf({ ...controlsRef.current, ...next })
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname],
  )

  useEffect(() => {
    let gone = false
    listPlanningSites(api, session.company?.id ?? null)
      .then((value) => !gone && setSites({ status: 'ready', value }))
      .catch((error) => {
        if (gone) return
        setSites({ status: 'error', problem: readProblemOf(error) })
        setRead({ status: 'error', problem: readProblemOf(error) })
      })
    return () => {
      gone = true
    }
  }, [api, session.company?.id])

  const today = site ? businessDate(new Date(), site.timeZone) : null
  const from = today ? windowFrom(controls, today) : undefined
  const load = useCallback(async (): Promise<Board | null> => {
    if (!siteId) {
      if (sites.status === 'ready') setRead({ status: 'error', problem: 'noSite' })
      return null
    }
    const id = ++readId.current
    try {
      const value = await getBoard(api, { siteId, from: controlsRef.current.from || controlsRef.current.zoom !== 'DAY' ? from : undefined, bucket: controlsRef.current.zoom })
      if (id !== readId.current) return value
      boardRef.current = value
      knownVersion.current = value.plan.version
      setRead({ status: 'ready', value })
      return value
    } catch (error) {
      if (id === readId.current) setRead({ status: 'error', problem: readProblemOf(error) })
      return null
    }
  }, [api, siteId, sites.status, from])

  useEffect(() => {
    if (sites.status !== 'ready') return
    setRead((current) => (current.status === 'ready' && current.value.site.id === siteId ? current : { status: 'loading' }))
    void load()
  }, [load, sites.status, siteId, controls.zoom])

  // ---- B-W2b-337: the change log ------------------------------------------------------------------------------------------

  const loadChanges = useCallback(
    async (more = false) => {
      if (!siteId) return
      const now = changesRef.current
      if (more) setChanges((current) => ({ ...current, more: true }))
      else setChanges((current) => (current.read.status === 'ready' ? current : { ...current, read: { status: 'loading' } }))
      try {
        const page = await getChanges(api, { siteId, since: now.since, kinds: kindsOf(now.kinds), changedById: now.planner, cursor: more && now.read.status === 'ready' ? now.read.value.next : null })
        setChanges((current) => {
          const entries = more && current.read.status === 'ready' ? [...current.read.value.entries, ...page.entries] : page.entries
          const value = { ...page, entries }
          // The planners named so far stay choices when a filter narrows the page.
          const known = new Map(current.planners.map((planner) => [planner.id, planner.name]))
          for (const planner of plannersOf(entries)) known.set(planner.id, planner.name)
          const planners = [...known.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
          return { ...current, read: { status: 'ready', value }, planners, more: false }
        })
      } catch (error) {
        setChanges((current) => (more ? { ...current, more: false, error: refusalOf(error) } : { ...current, read: { status: 'error', problem: readProblemOf(error) } }))
      }
    },
    [api, siteId],
  )

  useEffect(() => {
    if (siteId) void loadChanges()
  }, [siteId, changes.since, changes.kinds, changes.planner, loadChanges])

  // ---- B-W2b-337: the workshops' approvals and weekly capacity ---------------------------------------------------------------

  const board = read.status === 'ready' ? read.value : null
  const loadWorkshops = useCallback(async () => {
    if (!siteId) return
    try {
      setWorkshops({ status: 'ready', value: await getAllocationWorkshops(api, siteId) })
    } catch {
      setWorkshops({ status: 'error' })
    }
  }, [api, siteId])
  useEffect(() => {
    void loadWorkshops()
  }, [loadWorkshops])
  const windowKey = board ? `${board.site.id}|${board.from}|${board.to}|${board.bucket}` : null
  useEffect(() => {
    if (!board || !board.lanes.some((lane) => lane.kind === 'WORKSHOP')) return
    let gone = false
    getSubcontractorCapacity(api, { siteId: board.site.id, from: board.from, to: board.to, bucket: board.bucket })
      .then((value) => !gone && setSubcontractors({ status: 'ready', value }))
      .catch(() => !gone && setSubcontractors({ status: 'error' }))
    return () => {
      gone = true
    }
    // The window, not every read of the board.
  }, [api, windowKey])

  // ---- B-W2b-337: what-if ---------------------------------------------------------------------------------------------------

  const loadWhatIf = useCallback(
    async (scenarioId: string) => {
      setWhatIf((current) => (current && current.read.status === 'ready' && current.read.value.id === scenarioId ? current : { read: { status: 'loading' } }))
      try {
        const scenario = await getWhatIf(api, scenarioId)
        if (scenario.status !== 'DRAFT') {
          scenarioRef.current = null
          setWhatIf(null)
          setControls({ whatIf: null })
          return
        }
        scenarioRef.current = scenario
        setWhatIf({ read: { status: 'ready', value: scenario } })
      } catch (error) {
        if (isApiError(error) && error.kind === 'not_found') {
          scenarioRef.current = null
          setWhatIf(null)
          setControls({ whatIf: null })
          return
        }
        setWhatIf({ read: { status: 'error', problem: readProblemOf(error) } })
      }
    },
    [api, setControls],
  )
  useEffect(() => {
    if (controls.whatIf) void loadWhatIf(controls.whatIf)
    else {
      scenarioRef.current = null
      setWhatIf(null)
    }
  }, [controls.whatIf, loadWhatIf])

  const onWhatIf = useCallback(
    async (on: boolean) => {
      if (!on) return setControls({ whatIf: null })
      if (!siteId || controlsRef.current.whatIf) return
      setWhatIf({ read: { status: 'loading' } })
      try {
        const drafts = (await listWhatIfs(api, siteId)).filter((entry) => entry.status === 'DRAFT').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        const id = drafts[0]?.id ?? (await createWhatIf(api, siteId)).id
        setControls({ whatIf: id })
      } catch (error) {
        setWhatIf(null)
        setNotice(refusalWords(refusalOf(error), words))
      }
    },
    [api, setControls, siteId, words],
  )

  const tryMove = useCallback(
    async (plan: MovePlan, virtual: Board): Promise<boolean> => {
      const scenario = scenarioRef.current
      if (!scenario) return false
      const next = withTriedMove(whatIfInputs(scenario), plan, virtual)
      if (!next) return false
      setWhatIf((current) => (current ? { ...current, busy: true, error: null } : current))
      try {
        const answer = await setWhatIfMoves(api, scenario.id, { version: scenario.version, moves: next })
        scenarioRef.current = answer
        setWhatIf({ read: { status: 'ready', value: answer } })
        return true
      } catch (error) {
        setWhatIf((current) => (current ? { ...current, busy: false, error: refusalWords(refusalOf(error), words) } : current))
        if (isApiError(error) && error.kind === 'conflict') void loadWhatIf(scenario.id)
        return false
      }
    },
    [api, loadWhatIf, words],
  )

  // Live: another planner's change (a newer plan version), a publish, a calendar, capacity or a work order.
  const reread = useCoalesced(() => {
    void load()
    void loadChanges()
    if (scenarioRef.current) void loadWhatIf(scenarioRef.current.id)
  }, 700)
  const rereadWorkshops = useCoalesced(() => void loadWorkshops(), 900)
  const live = useLive(
    (change) => {
      const own = change.fields.siteId === undefined || change.fields.siteId === siteId
      if (change.type === 'planning.schedule_changed' && own) {
        const version = Number(change.fields.planVersion)
        if (knownVersion.current === null || version > knownVersion.current) {
          setNotice(t('notice.otherPlanner'))
          reread()
        }
      } else if ((change.type === 'planning.schedule_published' || change.type === 'planning.capacity_changed' || change.type === 'calendar.changed') && own) reread()
      else if (change.type.startsWith('workorder.') || change.type.startsWith('work_order.')) reread()
      // B-W2b-337: a workshop's approval, DURC, capacity or orders changed.
      if (/^(work_order_operation\.outsourced|subcontractor_capacity\.changed|subcontract_order\.|purchasing\.subcontract)/.test(change.type)) rereadWorkshops()
    },
    () => void load(),
    siteId !== null,
  )
  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' ? true : navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  const offline = !online || live === 'offline'

  // ---- moves ----------------------------------------------------------------------------------------------------------

  const askDrop = useCallback((card: string, laneName: string, days: OverDay[], source: 'board' | 'api', next: boolean) => {
    return new Promise<DropChoice>((resolve) => {
      dropAnswer.current = resolve
      setDialog({ kind: 'drop', cardLabel: card, laneName, days, source, next })
    })
  }, [])

  const askMaterial = useCallback((answer: MaterialAnswer) => {
    return new Promise<'snap' | 'keep' | 'cancel'>((resolve) => {
      materialAnswer.current = resolve
      setDialog({ kind: 'material', answer })
    })
  }, [])

  const send = useCallback(
    async (plan: Exclude<MovePlan, { kind: 'none' }>, overloadReason: string | null) => {
      if (plan.kind === 'remove') return removeSlot(api, plan.slotId, plan.version)
      if (plan.kind === 'place') return placeSlot(api, { workOrderId: plan.workOrderId, operationId: plan.operationId, lane: plan.lane, startAt: plan.startAt, ...(overloadReason ? { overloadReason } : {}) })
      return moveSlot(api, plan.slotId, { version: plan.version, ...(plan.lane ? { lane: plan.lane } : {}), ...(plan.startAt ? { startAt: plan.startAt } : {}), ...(overloadReason ? { overloadReason } : {}) })
    },
    [api],
  )

  const saved = useCallback(
    async (answer: { planVersion: number }) => {
      knownVersion.current = answer.planVersion
      setSave({ state: 'saved', at: new Date().toISOString() })
      await load()
      void loadChanges()
    },
    [load, loadChanges],
  )

  /** Undo one change of the log (a 409 OVERLOAD asks Keep with a reason, then again). */
  const undo = useCallback(
    async (entry: ChangeEntry, board: Board | null): Promise<boolean> => {
      setChanges((current) => ({ ...current, busy: entry.id, error: null }))
      setSave({ state: 'saving' })
      let reason: string | null = null
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const answer = await undoChange(api, entry.id, reason)
          lastUndone.current = answer.undone
          setChanges((current) => ({ ...current, busy: null }))
          setNotice(td('notice.undone'))
          await saved({ planVersion: answer.planVersion })
          return true
        } catch (error) {
          const refusal = refusalOf(error)
          if (refusal.code === 'OVERLOAD' && reason === null) {
            const lane = entry.from?.lane ?? entry.to?.lane
            const laneName = lane && board ? (board.lanes.find((candidate) => candidate.kind === lane.kind && candidate.id === lane.id)?.name ?? lane.code) : (lane?.code ?? '')
            const choice = await askDrop(entry.workOrder?.number ?? '', laneName, overFromIssues(error, lane ? laneKeyOf(lane) : null), 'api', false)
            if (choice.kind !== 'keep') break
            reason = choice.reason
            continue
          }
          setSave({ state: 'failed', refusal })
          setChanges((current) => ({ ...current, busy: null, error: refusal }))
          void loadChanges()
          return false
        }
      }
      setSave({ state: 'idle' })
      setChanges((current) => ({ ...current, busy: null }))
      return false
    },
    [api, askDrop, loadChanges, saved, td],
  )

  const openSubcontract = useCallback(
    (slotId: string, partyId: string | null, start: string | null) => {
      const board = boardRef.current
      const slot = board?.slots.find((entry) => entry.id === slotId)
      if (!board || !slot || slot.operationId === null) return
      const workOrder = board.workOrders.find((entry) => entry.id === slot.workOrderId)
      const operation = workOrder?.operations.find((entry) => entry.id === slot.operationId)
      const pieces = Math.max(1, operation?.remainingPieces ?? workOrder?.garments ?? 1)
      // The kit leaves "start − transport days": the start is the drop's day, else the bar's own day on the board.
      const day = start ?? new Intl.DateTimeFormat('en-CA', { timeZone: board.site.timeZone }).format(new Date(slot.startAt))
      setDialog({ kind: 'subcontract', slotId, workOrderId: slot.workOrderId, operationId: slot.operationId, partyId, start: day, pieces, workshops: { status: 'loading' }, timing: null })
      getWorkOrderWorkshops(api, slot.workOrderId, [slot.operationId])
        .then((value) => {
          const offered = value.workshops.filter((workshop) => workshop.offered)
          const picked = partyId ?? (offered.length === 1 ? offered[0]!.id : null)
          setDialog((current) => (current?.kind === 'subcontract' && current.slotId === slotId ? { ...current, workshops: { status: 'ready', value }, partyId: picked } : current))
        })
        .catch((error) => setDialog((current) => (current?.kind === 'subcontract' && current.slotId === slotId ? { ...current, workshops: { status: 'error', problem: readProblemOf(error) } } : current)))
    },
    [api],
  )

  const onMove = useCallback(
    async (move: PlanningMove): Promise<boolean> => {
      const working = boardRef.current
      if (!working) return false
      const scenario = scenarioRef.current
      const board = controlsRef.current.whatIf && scenario ? whatIfBoard(working, scenario) : working
      let plan = planMove(board, controlsRef.current, move, new Date())
      if (plan.kind === 'none') return false
      // B-W2b-337: in what-if a move is only tried (the scenario's list), never written to the working plan.
      if (controlsRef.current.whatIf) return scenario ? tryMove(plan, board) : false
      // B-W2b-337: ⌘Z on the board undoes the bar's change in the log (an UNDO entry), not a new move.
      if (move.via === 'undo' && plan.kind !== 'place') {
        const slotId = plan.slotId
        const latest = changesRef.current.read.status === 'ready' ? changesRef.current.read.value.entries.find((entry) => entry.slotId === slotId && entry.kind !== 'UNDO') : undefined
        if (latest?.undo.may) return undo(latest, working)
      }
      // B-W2b-337: a bar dropped on a workshop goes outside there with its kit (Move to a subcontractor), never as a bare move.
      const outside = workshopDropOf(board, plan)
      if (outside) {
        openSubcontract(outside.slotId, outside.partyId, outside.start)
        return false
      }
      const drawn = drawBoard(board, controlsRef.current, words, session.user.id)
      const card = drawn.cards.find((entry) => entry.id === move.cardId)
      const lane = drawn.lanes.find((entry) => entry.id === move.to.laneId)
      // B-W2b-337: a start earlier than the material asks first (Snap to the earliest start · Keep my date · Cancel).
      const ask = materialAsk(board, plan)
      if (ask) {
        try {
          const answer = await getMaterial(api, ask.workOrderId, { startAt: ask.startAt, laneKind: ask.laneKind, laneId: ask.laneId })
          if (answer.check && !answer.check.inTime) {
            const choice = await askMaterial(answer)
            if (choice === 'cancel') return false
            if (choice === 'snap' && answer.check.snapTo) plan = plan.kind === 'place' ? { ...plan, startAt: answer.check.snapTo } : plan.kind === 'move' ? { ...plan, startAt: answer.check.snapTo } : plan
          }
        } catch {
          // The check is a warning only: a failed read never holds the move.
        }
      }
      let reason: string | null = null
      // The DS's own estimate says the drop goes over: ask first (Keep with a reason · the next free day · Cancel).
      if (move.over && plan.kind !== 'remove') {
        const next = nextFreePlace(drawn, move)
        const choice = await askDrop(card?.label ?? '', lane?.label ?? '', overFromMove(move.loadAfter), 'board', next !== null)
        if (choice.kind === 'cancel') return false
        if (choice.kind === 'next') {
          plan = next ? planMove(board, controlsRef.current, { ...move, to: next }, new Date()) : plan
          if (plan.kind === 'none') return false
          setSave({ state: 'saving' })
          try {
            await saved(await send(plan, null))
            setNotice(t('notice.nextFree', { order: card?.label ?? '' }))
          } catch (error) {
            setSave({ state: 'failed', refusal: refusalOf(error) })
          }
          // The board said "not moved" for the place it was dropped on: the bar is at the next free day instead.
          return false
        }
        reason = choice.reason
      }
      setSave({ state: 'saving' })
      let started = false
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await saved(await send(plan, reason))
          return true
        } catch (error) {
          const refusal = refusalOf(error)
          // B-W2b-263: the order waits on a pre-production gate: Start before the gate? (someone other than its planner), then again.
          if (refusal.code === 'GATE_NOT_PASSED' && !started) {
            setSave({ state: 'idle' })
            started = await gate.ask(refusal.gates)
            if (!started) {
              setSave({ state: 'failed', refusal })
              return false
            }
            setSave({ state: 'saving' })
            continue
          }
          if (refusal.code === 'OVERLOAD' && reason === null) {
            // The API counts the work not on the board too: its numbers, then the same choice.
            const choice = await askDrop(card?.label ?? '', lane?.label ?? '', overFromIssues(error, move.to.laneId), 'api', false)
            if (choice.kind !== 'keep') {
              setSave({ state: 'idle' })
              return false
            }
            reason = choice.reason
            continue
          }
          setSave({ state: 'failed', refusal })
          if (refusal.code === 'MOVED_BY' || refusal.code === 'PLAN_CHANGED' || refusal.code === 'NOT_FOUND' || refusal.code === 'PINNED') void load()
          return false
        }
      }
      return false
    },
    [api, askDrop, askMaterial, gate, load, openSubcontract, saved, send, session.user.id, t, tryMove, undo, words],
  )

  const onDropChoice = useCallback((choice: DropChoice) => {
    const answer = dropAnswer.current
    dropAnswer.current = null
    setDialog(null)
    answer?.(choice)
  }, [])

  const onMaterialChoice = useCallback((choice: 'snap' | 'keep' | 'cancel') => {
    const answer = materialAnswer.current
    materialAnswer.current = null
    setDialog(null)
    answer?.(choice)
  }, [])

  // ---- B-W2b-337: pins --------------------------------------------------------------------------------------------------------

  const onPin = useCallback(
    async (slotId: string, pinned: boolean) => {
      const slot = boardRef.current?.slots.find((entry) => entry.id === slotId)
      if (!slot) return
      setSave({ state: 'saving' })
      try {
        await saved(await pinSlot(api, slot.id, { version: slot.version, pinned }))
        setNotice(td(pinned ? 'notice.pinned' : 'notice.unpinned'))
        setDialog((current) => (current?.kind === 'bar' ? { ...current, busy: false, error: null } : current))
      } catch (error) {
        const refusal = refusalOf(error)
        setSave({ state: 'failed', refusal })
        setDialog((current) => (current?.kind === 'bar' ? { ...current, busy: false, error: refusalWords(refusal, words) } : current))
        if (refusal.code === 'MOVED_BY') void load()
      }
    },
    [api, load, saved, td, words],
  )

  const onPinOrder = useCallback(
    async (workOrderId: string, pinned: boolean) => {
      setSave({ state: 'saving' })
      try {
        const answer = await pinWorkOrder(api, workOrderId, { pinned, ...(boardRef.current?.plan.version ? { planVersion: boardRef.current.plan.version } : {}) })
        await saved(answer)
        setNotice(td(pinned ? 'notice.pinnedOrder' : 'notice.unpinnedOrder', { count: answer.changed, bars: String(answer.changed) }))
      } catch (error) {
        const refusal = refusalOf(error)
        setSave({ state: 'failed', refusal })
        setDialog((current) => (current?.kind === 'bar' ? { ...current, error: refusalWords(refusal, words) } : current))
        if (refusal.code === 'PLAN_CHANGED') void load()
      }
    },
    [api, load, saved, td, words],
  )

  // ---- B-W2b-337: Move to a subcontractor --------------------------------------------------------------------------------------

  const subcontractTiming = useCallback(
    (state: Extract<BoardDialog, { kind: 'subcontract' }>) => {
      if (!state.partyId) return
      const key = `${state.partyId}|${state.pieces}`
      getKitTimingAt(api, state.workOrderId, { partyId: state.partyId, operationId: state.operationId, pieces: state.pieces, start: state.start })
        .then((value) => setDialog((current) => (current?.kind === 'subcontract' && `${current.partyId}|${current.pieces}` === key ? { ...current, timing: { status: 'ready', value } } : current)))
        .catch((error) => {
          const problem = kitProblemOf(error)
          setDialog((current) => (current?.kind === 'subcontract' && `${current.partyId}|${current.pieces}` === key ? { ...current, timing: { status: 'error', problem: problem === 'noWork' ? 'failed' : problem } } : current))
        })
    },
    [api],
  )
  const subcontractKey = dialog?.kind === 'subcontract' ? `${dialog.slotId}|${dialog.partyId}|${dialog.pieces}|${dialog.workshops.status}` : null
  useEffect(() => {
    if (dialog?.kind !== 'subcontract' || !dialog.partyId || dialog.workshops.status !== 'ready' || dialog.done) return
    setDialog((current) => (current?.kind === 'subcontract' ? { ...current, timing: { status: 'loading' } } : current))
    subcontractTiming(dialog)
    // Read again when the workshop or the garments change.
  }, [subcontractKey])

  const onSubcontractConfirm = useCallback(async () => {
    if (dialog?.kind !== 'subcontract' || dialog.workshops.status !== 'ready' || !dialog.partyId) return
    const state = dialog
    const operation = dialog.workshops.value.operations.find((entry) => entry.id === state.operationId)
    if (!operation) return
    setDialog({ ...state, busy: true, error: null })
    setSave({ state: 'saving' })
    let sent: OutsideAnswer
    try {
      sent = await sendOutsideAt(api, state.workOrderId, state.operationId, { version: operation.version, partyId: state.partyId!, ...(state.pieces ? { pieces: state.pieces } : {}), ...(state.start ? { start: state.start } : {}) })
    } catch (error) {
      const refusal = switchRefusalOf(error)
      const workshop = state.workshops.status === 'ready' ? state.workshops.value.workshops.find((entry) => entry.id === state.partyId) : undefined
      const allocation = workshops.status === 'ready' ? workshops.value : null
      const text = refusal.code === 'HELD' ? refusal.holds.map((hold) => holdWords(hold, workshopOf(allocation, state.partyId!) ?? workshop ?? null, site?.name ?? '', aw)).join(' ') : switchRefusalWords(refusal, aw)
      setSave({ state: 'idle' })
      setDialog((current) => (current?.kind === 'subcontract' ? { ...current, busy: false, error: text } : current))
      if (refusal.code === 'CHANGED') openSubcontract(state.slotId, state.partyId, state.start)
      return
    }
    // The bar follows its work to the workshop's lane (one more change of the log).
    const slot = boardRef.current?.slots.find((entry) => entry.id === state.slotId)
    let stayed: Refusal | null = null
    if (slot && !(slot.lane.kind === 'WORKSHOP' && slot.lane.id === state.partyId)) {
      try {
        await saved(await moveSlot(api, slot.id, { version: slot.version, lane: { kind: 'WORKSHOP', id: state.partyId! } }))
      } catch (error) {
        stayed = refusalOf(error)
        await load()
      }
    } else await saved({ planVersion: boardRef.current?.plan.version ?? 0 })
    void loadWorkshops()
    setNotice(stayed ? null : td('notice.outside'))
    setDialog((current) => (current?.kind === 'subcontract' ? { ...current, busy: false, done: { answer: sent, stayed } } : current))
  }, [api, aw, dialog, load, loadWorkshops, openSubcontract, saved, site?.name, td, workshops])

  // ---- the bar's detail --------------------------------------------------------------------------------------------

  const openBar = useCallback(
    (workOrderId: string, slotId: string | null) => {
      setDialog({ kind: 'bar', workOrderId, slotId, detail: { status: 'loading' } })
      getBarDetail(api, workOrderId)
        .then((value) => setDialog((current) => (current?.kind === 'bar' && current.workOrderId === workOrderId ? { ...current, detail: { status: 'ready', value } } : current)))
        .catch((error) => setDialog((current) => (current?.kind === 'bar' && current.workOrderId === workOrderId ? { ...current, detail: { status: 'error', problem: readProblemOf(error) } } : current)))
    },
    [api],
  )

  const onOpen = useCallback(
    (card: PlanningCard) => {
      const board = boardRef.current
      const fromTray = workOrderOfTrayCard(card.id)
      const slot = fromTray ? null : board?.slots.find((entry) => entry.id === card.id)
      const workOrderId = fromTray ?? slot?.workOrderId
      if (!workOrderId) return
      setControls({ wo: workOrderId })
      openBar(workOrderId, slot?.id ?? null)
    },
    [openBar, setControls],
  )

  // A link with `?wo=` opens the bar's detail.
  useEffect(() => {
    if (controls.wo && read.status === 'ready' && dialog === null) {
      const slot = read.value.slots.find((entry) => entry.workOrderId === controls.wo)
      openBar(controls.wo, slot?.id ?? null)
    }
    // Only when the address names another work order (not on every dialog change).
  }, [controls.wo, read.status])

  const onSendToTray = useCallback(
    async (slotId: string) => {
      const slot = boardRef.current?.slots.find((entry) => entry.id === slotId)
      if (!slot) return
      setDialog((current) => (current?.kind === 'bar' ? { ...current, busy: true, error: null } : current))
      setSave({ state: 'saving' })
      try {
        await saved(await removeSlot(api, slot.id, slot.version))
        setDialog(null)
        setControls({ wo: null })
      } catch (error) {
        const refusal = refusalOf(error)
        const words2 = refusalWords(refusal, words)
        setSave({ state: 'failed', refusal })
        setDialog((current) => (current?.kind === 'bar' ? { ...current, busy: false, error: words2 } : current))
      }
    },
    [api, saved, setControls, words],
  )

  // ---- publish -------------------------------------------------------------------------------------------------------

  const preview = useCallback(
    async (range: PublishRangeKind, wanted: PublishRange) => {
      if (!siteId) return
      setDialog((current) => (current?.kind === 'publish' ? { ...current, range, preview: { status: 'loading' }, error: null } : { kind: 'publish', range, from: null, to: null, preview: { status: 'loading' } }))
      try {
        const value = await getPublishPreview(api, siteId, wanted)
        if (value.range.isDefault) defaultRange.current = { from: value.range.coversFrom, to: value.range.coversTo }
        setDialog((current) => (current?.kind === 'publish' ? { ...current, from: value.range.coversFrom, to: value.range.coversTo, preview: { status: 'ready', value } } : current))
      } catch (error) {
        const refusal = refusalOf(error)
        setDialog((current) => (current?.kind === 'publish' ? { ...current, preview: { status: 'error', problem: readProblemOf(error) }, error: refusal.code === 'INVALID' ? t('publish.rangeRefused') : null } : current))
      }
    },
    [api, siteId, t],
  )

  const onPublishRange = useCallback(
    (range: PublishRangeKind, from?: string | null, to?: string | null) => {
      if (range === 'default') void preview('default', {})
      else if (range === 'tomorrow') {
        const first = defaultRange.current?.from
        void preview('tomorrow', first ? { coversFrom: first, coversTo: first } : {})
      } else if (from && to) void preview('custom', { coversFrom: from, coversTo: to })
      else setDialog((current) => (current?.kind === 'publish' ? { ...current, range: 'custom' } : current))
    },
    [preview],
  )

  const onPublish = useCallback(async () => {
    if (dialog?.kind !== 'publish' || dialog.preview.status !== 'ready' || !siteId) return
    const value = dialog.preview.value
    if (value.plan.version === null) return
    setDialog({ ...dialog, busy: true, error: null })
    try {
      const answer = await publishPlan(api, { siteId, version: value.plan.version, coversFrom: value.range.coversFrom, coversTo: value.range.coversTo })
      setDialog((current) => (current?.kind === 'publish' ? { ...current, busy: false, done: answer.version } : current))
      setNotice(t('notice.published', { version: answer.version.number }))
      void load()
      void loadChanges()
    } catch (error) {
      const refusal = refusalOf(error)
      setDialog((current) => (current?.kind === 'publish' ? { ...current, busy: false, error: refusal.code === 'PLAN_CHANGED' ? t('publish.planChanged') : refusalWords(refusal, words) } : current))
      if (refusal.code === 'PLAN_CHANGED') void preview(dialog.range, dialog.range === 'default' ? {} : { coversFrom: value.range.coversFrom, coversTo: value.range.coversTo })
    }
  }, [api, dialog, load, loadChanges, preview, siteId, t, words])

  // ---- place all by due date ------------------------------------------------------------------------------------------

  const openPlace = useCallback(async () => {
    if (!siteId) return
    setDialog({ kind: 'place', preview: { status: 'loading' } })
    try {
      const value = await placeByDueDate(api, { siteId, apply: false })
      setDialog((current) => (current?.kind === 'place' ? { ...current, preview: { status: 'ready', value } } : current))
    } catch (error) {
      const refusal = refusalOf(error)
      setDialog((current) => (current?.kind === 'place' ? { ...current, preview: { status: 'ready', value: { planVersion: null, applied: false, slots: [], skipped: [], overbooked: 0, replayed: false } }, error: refusalWords(refusal, words) } : current))
    }
  }, [api, siteId, words])

  const onPlaceApply = useCallback(
    async (reason: string | null) => {
      if (!siteId) return
      const version = boardRef.current?.plan.version ?? undefined
      setDialog((current) => (current?.kind === 'place' ? { ...current, busy: true, error: null } : current))
      setSave({ state: 'saving' })
      try {
        const answer = await placeByDueDate(api, { siteId, apply: true, ...(version ? { version } : {}), ...(reason ? { overloadReason: reason } : {}) })
        setDialog(null)
        setNotice(t('notice.placed', { count: answer.slots.length }))
        if (answer.planVersion !== null) await saved({ planVersion: answer.planVersion })
        else setSave({ state: 'saved', at: new Date().toISOString() })
      } catch (error) {
        const refusal = refusalOf(error)
        const text = refusal.code === 'PLAN_CHANGED' ? t('place.planChanged') : refusalWords(refusal, words)
        setSave({ state: 'failed', refusal })
        setDialog((current) => (current?.kind === 'place' ? { ...current, busy: false, error: text } : current))
        if (refusal.code === 'PLAN_CHANGED') void load()
      }
    },
    [api, load, saved, siteId, t, words],
  )

  // ---- B-W2b-337: Reschedule backlog -----------------------------------------------------------------------------------------

  const openBacklog = useCallback(async () => {
    if (!siteId) return
    setDialog({ kind: 'backlog', preview: { status: 'loading' } })
    try {
      const value = await rescheduleBacklog(api, { siteId, apply: false })
      // A preview that moves nothing says so (the same words as the API's NOTHING_TO_RESCHEDULE on apply).
      setDialog((current) => (current?.kind === 'backlog' ? { ...current, preview: value.moves.length === 0 ? { status: 'nothing' } : { status: 'ready', value } } : current))
    } catch (error) {
      const refusal = refusalOf(error)
      if (refusal.code === 'NOTHING_TO_RESCHEDULE') return setDialog((current) => (current?.kind === 'backlog' ? { ...current, preview: { status: 'nothing' } } : current))
      setDialog((current) => (current?.kind === 'backlog' ? { ...current, preview: { status: 'error', problem: readProblemOf(error) } } : current))
    }
  }, [api, siteId])

  const onBacklogApply = useCallback(
    async (reason: string | null) => {
      if (!siteId) return
      const version = boardRef.current?.plan.version ?? undefined
      setDialog((current) => (current?.kind === 'backlog' ? { ...current, busy: true, error: null } : current))
      setSave({ state: 'saving' })
      try {
        const answer = await rescheduleBacklog(api, { siteId, apply: true, ...(version ? { version } : {}), ...(reason ? { overloadReason: reason } : {}) })
        setDialog(null)
        setNotice(td('notice.backlog', { count: answer.moves.length, bars: String(answer.moves.length) }))
        if (answer.planVersion !== null) await saved({ planVersion: answer.planVersion })
        else setSave({ state: 'saved', at: new Date().toISOString() })
      } catch (error) {
        const refusal = refusalOf(error)
        setSave({ state: 'failed', refusal })
        setDialog((current) => (current?.kind === 'backlog' ? { ...current, busy: false, error: refusal.code === 'PLAN_CHANGED' ? td('backlog.planChanged') : refusalWords(refusal, words) } : current))
        if (refusal.code === 'PLAN_CHANGED') {
          await load()
          void openBacklog()
        }
      }
    },
    [api, load, openBacklog, saved, siteId, td, words],
  )

  // ---- B-W2b-337: What-if Apply / Discard -------------------------------------------------------------------------------------

  const applyScenario = useCallback(
    async (skipConflicts: boolean) => {
      const scenario = scenarioRef.current
      if (!scenario) return
      setWhatIf((current) => (current ? { ...current, busy: true, error: null } : current))
      if (skipConflicts) setDialog((current) => (current?.kind === 'whatifConflicts' ? { ...current, busy: true, error: null } : current))
      setSave({ state: 'saving' })
      let reason: string | null = null
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const answer = await applyWhatIf(api, scenario.id, { version: scenario.version, ...(reason ? { overloadReason: reason } : {}), ...(skipConflicts ? { skipConflicts: true } : {}) })
          setDialog(null)
          setNotice(td('notice.whatIfApplied', { count: answer.applied, moves: String(answer.applied) }))
          scenarioRef.current = null
          setWhatIf(null)
          setControls({ whatIf: null })
          await saved({ planVersion: answer.planVersion })
          return
        } catch (error) {
          const refusal = refusalOf(error)
          if (refusal.code === 'WHAT_IF_CONFLICTS') {
            setSave({ state: 'idle' })
            setWhatIf((current) => (current ? { ...current, busy: false } : current))
            setDialog({ kind: 'whatifConflicts', conflicts: applyConflicts(error, scenario) })
            void loadWhatIf(scenario.id)
            return
          }
          if (refusal.code === 'OVERLOAD' && reason === null) {
            const choice = await askDrop(td('whatif.title'), '', overFromIssues(error, null), 'api', false)
            if (choice.kind !== 'keep') break
            reason = choice.reason
            continue
          }
          setSave({ state: 'failed', refusal })
          setWhatIf((current) => (current ? { ...current, busy: false, error: refusalWords(refusal, words) } : current))
          setDialog((current) => (current?.kind === 'whatifConflicts' ? { ...current, busy: false, error: refusalWords(refusal, words) } : current))
          void loadWhatIf(scenario.id)
          return
        }
      }
      setSave({ state: 'idle' })
      setWhatIf((current) => (current ? { ...current, busy: false } : current))
    },
    [api, askDrop, loadWhatIf, saved, setControls, td, words],
  )

  const onWhatIfDiscard = useCallback(async () => {
    const scenario = scenarioRef.current
    if (!scenario) return
    setWhatIf((current) => (current ? { ...current, busy: true, error: null } : current))
    try {
      await discardWhatIf(api, scenario.id, scenario.version)
      scenarioRef.current = null
      setWhatIf(null)
      setControls({ whatIf: null })
      setNotice(td('notice.whatIfDiscarded'))
    } catch (error) {
      setWhatIf((current) => (current ? { ...current, busy: false, error: refusalWords(refusalOf(error), words) } : current))
    }
  }, [api, setControls, td, words])

  // ---- B-W2b-337: Print day sheets --------------------------------------------------------------------------------------------

  const sheetQuery = useCallback(
    (state: Extract<BoardDialog, { kind: 'print' }>): SheetQuery | null => (siteId ? { siteId, date: state.date, ...sheetIds(state.lanes), plan: state.plan, language: state.language } : null),
    [siteId],
  )
  const readPaper = useCallback(
    (state: Extract<BoardDialog, { kind: 'print' }>) => {
      const ask = sheetQuery(state)
      if (!ask || !state.date) return
      const key = JSON.stringify(ask)
      setDialog((current) => (current?.kind === 'print' ? { ...current, paper: { status: 'loading' }, error: null } : current))
      getDaySheetPaper(api, ask)
        .then((value) => setDialog((current) => (current?.kind === 'print' && JSON.stringify(sheetQuery(current)) === key ? { ...current, paper: { status: 'ready', value } } : current)))
        .catch((error) =>
          setDialog((current) => (current?.kind === 'print' && JSON.stringify(sheetQuery(current)) === key ? { ...current, paper: isApiError(error) && error.kind === 'not_found' ? { status: 'noVersion' } : { status: 'error', problem: readProblemOf(error) } } : current)),
        )
    },
    [api, sheetQuery],
  )
  const onPrintChange = useCallback(
    (next: { lanes?: readonly string[]; date?: string; language?: 'it' | 'en'; plan?: 'PUBLISHED' | 'WORKING' }) => {
      if (dialog?.kind !== 'print') return
      const state = { ...dialog, ...next }
      setDialog(state)
      readPaper(state)
    },
    [dialog, readPaper],
  )
  const onPrintOpen = useCallback(async () => {
    if (dialog?.kind !== 'print') return
    const ask = sheetQuery(dialog)
    if (!ask) return
    // Opened now, while the click allows a new tab; filled when the PDF is here.
    const tab = typeof window !== 'undefined' ? window.open('about:blank', '_blank') : null
    setDialog({ ...dialog, busy: true, error: null })
    try {
      const bytes = await getDaySheetPdf(api, ask)
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
      if (tab && !tab.closed) tab.location.href = url
      else window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setDialog((current) => (current?.kind === 'print' ? { ...current, busy: false } : current))
    } catch (error) {
      tab?.close()
      setDialog((current) => (current?.kind === 'print' ? { ...current, busy: false, ...(isApiError(error) && error.kind === 'not_found' ? { paper: { status: 'noVersion' as const } } : { error: refusalWords(refusalOf(error), words) }) } : current))
    }
  }, [api, dialog, sheetQuery, words])

  // ---- B-W2b-337: problems' quick fixes -------------------------------------------------------------------------------------

  const onProblemFix = useCallback(
    async (row: DepthProblemRow) => {
      if (row.fix === 'backlog') return void openBacklog()
      const board = boardRef.current
      const slot = row.slotId ? board?.slots.find((entry) => entry.id === row.slotId) : undefined
      if (!slot) return
      setSave({ state: 'saving' })
      try {
        const answer = await getMaterial(api, slot.workOrderId, { startAt: slot.startAt, laneKind: slot.lane.kind, laneId: slot.lane.id })
        const snap = answer.check?.snapTo ?? answer.materialStart.earliestStart
        if (!snap) {
          setSave({ state: 'idle' })
          setNotice(td('notice.noSnap', { order: answer.workOrder.number }))
          return
        }
        await saved(await moveSlot(api, slot.id, { version: slot.version, startAt: snap }))
        setNotice(td('notice.snapped', { order: answer.workOrder.number }))
      } catch (error) {
        const refusal = refusalOf(error)
        setSave({ state: 'failed', refusal })
        if (refusal.code === 'MOVED_BY') void load()
      }
    },
    [api, load, openBacklog, saved, td],
  )

  // ---- the rest -------------------------------------------------------------------------------------------------------

  const onOpenDialog = useCallback(
    (kind: 'publish' | 'place' | 'legend' | 'versions' | 'keys') => {
      if (kind === 'publish') void preview('default', {})
      else if (kind === 'place') void openPlace()
      else if (kind === 'versions') {
        if (!siteId) return
        setDialog({ kind: 'versions', versions: { status: 'loading' } })
        listVersions(api, siteId)
          .then((value) => setDialog((current) => (current?.kind === 'versions' ? { kind: 'versions', versions: { status: 'ready', value } } : current)))
          .catch((error) => setDialog((current) => (current?.kind === 'versions' ? { kind: 'versions', versions: { status: 'error', problem: readProblemOf(error) } } : current)))
      } else setDialog({ kind })
    },
    [api, openPlace, preview, siteId],
  )

  const onDepthDialog = useCallback(
    (kind: 'print' | 'backlog' | 'export') => {
      const board = boardRef.current
      if (kind === 'backlog') return void openBacklog()
      if (kind === 'print') {
        const state: Extract<BoardDialog, { kind: 'print' }> = { kind: 'print', lanes: [], date: board?.today ?? today ?? '', language: locale === 'en' ? 'en' : 'it', plan: 'PUBLISHED', paper: null }
        setDialog(state)
        readPaper(state)
        return
      }
      if (!board || !siteId) return
      // Outside the Office's list tools there is no export: said, never a dialog that waits.
      if (!exporter.available) return setDialog({ kind: 'export', job: null, problem: 'failed' })
      setDialog({ kind: 'export', job: null, problem: null })
      void exporter.start(exportQuery({ siteId, from: board.from, to: board.to }))
    },
    [exporter, locale, openBacklog, readPaper, siteId, today],
  )
  // The export dialog shows the list tools' job as it runs.
  useEffect(() => {
    if (!exporter.state) return
    setDialog((current) => (current?.kind === 'export' ? { kind: 'export', job: exporter.state!.job, problem: exporter.state!.problem } : current))
  }, [exporter.state])

  const onCloseDialog = useCallback(() => {
    if (dialog?.kind === 'drop') return onDropChoice({ kind: 'cancel' })
    if (dialog?.kind === 'material') return onMaterialChoice('cancel')
    // The bar's detail (and Move to a subcontractor opened from it) keeps `?wo=` in the address until it closes.
    if (dialog?.kind === 'bar' || dialog?.kind === 'subcontract') setControls({ wo: null })
    if (dialog?.kind === 'export') exporter.close()
    setDialog(null)
  }, [dialog, exporter, onDropChoice, onMaterialChoice, setControls])

  const showWorkOrder = useCallback(
    (workOrderId: string | null, slotId: string | null, laneId: string | null, date: string | null) => {
      const board = boardRef.current
      setDialog(null)
      const slot = slotId ? board?.slots.find((entry) => entry.id === slotId) : workOrderId ? board?.slots.find((entry) => entry.workOrderId === workOrderId) : undefined
      if (slot) {
        if (controlsRef.current.view === 'orders' || !controlsRef.current.lanes.length || controlsRef.current.lanes.includes(laneKeyOf(slot.lane))) setFocus({ cardId: slot.id })
        else {
          setControls({ lanes: [] })
          setFocus({ cardId: slot.id })
        }
        return
      }
      if (workOrderId && board?.tray.some((entry) => entry.workOrderId === workOrderId)) return setFocus({ cardId: `tray:${workOrderId}` })
      if (laneId) {
        if (date && board && (date < board.from || date > board.to)) setControls({ from: date })
        setFocus({ laneId })
      }
    },
    [setControls],
  )

  // ---- B-W2b-337: ⌘Z / ⌘⇧Z outside the board: the planner's own newest change of the log; redo is a new move ---------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z' || dialog) return
      const target = event.target as HTMLElement | null
      if (target && typeof target.closest === 'function' && (target.isContentEditable || target.closest('input, textarea, select, [role="dialog"], .nds-pb'))) return
      if (controlsRef.current.whatIf) return
      event.preventDefault()
      const board = boardRef.current
      if (!event.shiftKey) {
        const entries = changesRef.current.read.status === 'ready' ? changesRef.current.read.value.entries : []
        const latest = myLatestUndoable(entries, session.user.id)
        if (latest) void undo(latest, board)
        else setNotice(td('notice.nothingToUndo'))
        return
      }
      const undone = lastUndone.current
      const slot = undone?.slotId ? board?.slots.find((entry) => entry.id === undone.slotId) : undefined
      if (!undone?.to || !slot) return setNotice(td('notice.nothingToRedo'))
      lastUndone.current = null
      setSave({ state: 'saving' })
      moveSlot(api, slot.id, { version: slot.version, lane: { kind: undone.to.lane.kind, id: undone.to.lane.id }, startAt: undone.to.startAt })
        .then((answer) => saved(answer))
        .then(() => setNotice(td('notice.redone')))
        .catch((error) => setSave({ state: 'failed', refusal: refusalOf(error) }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [api, dialog, saved, session.user.id, td, undo])

  const virtualRead: Loaded<Board> = read.status === 'ready' && controls.whatIf && whatIf?.read.status === 'ready' ? { status: 'ready', value: whatIfBoard(read.value, whatIf.read.value) } : read

  const model: BoardViewModel = {
    prefix,
    me: session.user.id,
    sites: sites.status === 'ready' ? sites.value : [],
    controls: { ...controls, site: siteId },
    read: virtualRead,
    offline,
    save,
    dialog,
    notice,
    focus,
    depth: { may: { ...may, export: exporter.available }, whatIf, changes, workshops, subcontractors },
  }

  return (
    <>
      <BoardView
        model={model}
        actions={{
          onControls: setControls,
          onRetry: () => {
            setRead({ status: 'loading' })
            void load()
          },
          onMove,
          onOpen,
          onOpenDialog,
          onCloseDialog,
          onDropChoice,
          onPublishRange,
          onPublish: () => void onPublish(),
          onPlaceApply: (reason) => void onPlaceApply(reason),
          onSendToTray: (slotId) => void onSendToTray(slotId),
          onShowProblem: (row: ProblemRow) => showWorkOrder(row.workOrderId, null, row.laneId, row.date),
          onShowCheck: (target) => showWorkOrder(target.workOrderId, target.slotId, target.laneId, null),
          // B-W2b-337
          onNotice: setNotice,
          onDepthDialog,
          onWhatIf: (on) => void onWhatIf(on),
          onWhatIfApply: () => void applyScenario(false),
          onWhatIfApplyRest: () => void applyScenario(true),
          onWhatIfDiscard: () => void onWhatIfDiscard(),
          onWhatIfRetry: () => controls.whatIf && void loadWhatIf(controls.whatIf),
          onPin: (slotId, pinned) => void onPin(slotId, pinned),
          onPinOrder: (workOrderId, pinned) => void onPinOrder(workOrderId, pinned),
          onSubcontract: (slotId) => openSubcontract(slotId, null, null),
          onSubcontractPick: (partyId) => setDialog((current) => (current?.kind === 'subcontract' ? { ...current, partyId, timing: null, error: null } : current)),
          onSubcontractPieces: (pieces) => setDialog((current) => (current?.kind === 'subcontract' ? { ...current, pieces, error: null } : current)),
          onSubcontractConfirm: () => void onSubcontractConfirm(),
          onSubcontractRetry: () => dialog?.kind === 'subcontract' && openSubcontract(dialog.slotId, dialog.partyId, dialog.start),
          onMaterialChoice,
          onPrintChange,
          onPrintOpen: () => void onPrintOpen(),
          onBacklogApply: (reason) => void onBacklogApply(reason),
          onChangesFilter: (next) => setChanges((current) => ({ ...current, ...next, error: null })),
          onChangesMore: () => void loadChanges(true),
          onChangesRetry: () => {
            setChanges((current) => ({ ...current, read: { status: 'loading' } }))
            void loadChanges()
          },
          onUndo: (changeId) => {
            const entry = changes.read.status === 'ready' ? changes.read.value.entries.find((candidate) => candidate.id === changeId) : undefined
            if (entry) void undo(entry, boardRef.current)
          },
          onProblemFix: (row) => void onProblemFix(row),
          onShowDepthProblem: (row) => showWorkOrder(row.workOrderId, row.slotId, row.laneId, row.date),
          onExportDownload: exporter.download,
          onExportAgain: exporter.again,
        }}
      />
      {gate.element}
    </>
  )
}
