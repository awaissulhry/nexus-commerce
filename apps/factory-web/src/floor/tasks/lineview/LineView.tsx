'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { useFloorListUpdates } from '@nexus/ui/floor/FloorListUpdates/index'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLiveChanges } from '../../../record-panels/live'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { AsOfMemory } from '../shared/as-of'
import { queuedView } from '../shared/queued'
import { floorStepUp, steppedUp } from '../shared/step-up'
import type { TaskOutcome, TaskProblem } from '../shared/task-api'
import { fetchCard } from '../scans/api'
import {
  approveBlock,
  approveScrap,
  decideConflict,
  overrideOnBehalf,
  readBehalfOptions,
  readBlocks,
  readBoard,
  readCalls,
  readConflicts,
  readFloorLine,
  readHandover,
  readOperators,
  readScrap,
  reassign,
  refuseScrap,
  rejectBlock,
  reportOnBehalf,
  undoEntry,
  type BehalfOptions,
  type CallsBoard,
  type ConflictDecisions,
  type FloorLine,
  type Handover,
  type RefusalTile,
} from './api'
import type { LineBoard } from '../../../lib/line-board/schema'
import {
  answerPayload,
  behalfHeld,
  behalfPayload,
  CALL_ANSWER,
  draftOfNote,
  EMPTY_BEHALF,
  EMPTY_HANDOVER,
  EMPTY_OVERRIDE,
  expectedOf,
  HANDOVER_WRITE,
  handoverHeld,
  handoverPayload,
  isOverridable,
  lineCan,
  nextItem,
  openOperations,
  overrideBody,
  overrideHeld,
  queuedAnswers,
  reassignHeld,
  reassignNeedsReason,
  rejectHeld,
  SCAN_ON_BEHALF,
  selectedCall,
  toggleTopic,
  waitingItems,
  waitingKey,
  waitingVersion,
  withDefects,
  type BehalfDraft,
  type WaitingItem,
} from './model'
import { LineViewScreen, type DecideAct, type LineAction, type LineStep } from './view/LineViewScreen'

/**
 * The live SCR-168 (`/floor/lineview`; B-W2b-70): what the team leader runs the line from. It reads the line's board, its
 * open calls, the stations' Reassign and who is signed in, and what waits for them, together; again on each live hint (at
 * most every few seconds), on a beat in view, and when the network is back. New rows wait behind "2 new · Show"
 * (useFloorListUpdates: they never move under a finger). Answering a call, a handover note and an entry on behalf save on the
 * tablet first when they must; a decision signed with the PIN and a reassign need the network and say so. What the tablet
 * read stays for this visit with its time (offline: "as of").
 */

interface LineData {
  readonly board: LineBoard | null
  readonly calls: CallsBoard | null
  readonly line: FloorLine | null
  readonly waiting: readonly WaitingItem[]
  /** A part could not be read now: the screen says so instead of an empty list. */
  readonly waitingUnknown: boolean
  readonly tiles: readonly RefusalTile[]
  readonly decisions: ConflictDecisions
}

const KEPT = new AsOfMemory<LineData>(1)
const NOTES = new AsOfMemory<Handover>(1)
const OPTIONS = new AsOfMemory<BehalfOptions>(1)
const REREAD_MS = 30_000
const LIVE_PAUSE_MS = 3_000
const LIVE = new Set([
  'help_call.raised',
  'help_call.answered',
  'help_call.changed',
  'production.scan_recorded',
  'production.scrap_over_limit_decided',
  'production.off_standard_ended',
  'production.off_standard_decided',
  'production.off_standard_recorded',
  'floor.action_refused',
  'floor.refused_action_closed',
  'floor.conflict_sent_to_office',
  'dispatch.assignment_changed',
  'dispatch.handover_written',
  'machine.status_changed',
])

const away = (problem: TaskProblem) => problem.kind === 'offline' || problem.kind === 'unavailable'
const value = <T,>(answer: TaskOutcome<T>): T | null => (answer.ok ? answer.value : null)

export function FloorLineView() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.lineview', { showHome: true })
  const { api, me, online, sessionEnded, queue, queueSnapshot } = store
  const permissions = me?.permissions
  const can = useMemo(() => lineCan(permissions ?? []), [permissions])
  const [data, setData] = useState<{ readonly value: LineData; readonly asOf: string | null } | null>(null)
  const [step, setStep] = useState<LineStep>({ kind: 'loading' })
  const [picked, setPicked] = useState<string | null>(null)
  const [stepUntil, setStepUntil] = useState<string | null>(null)
  const current = useRef(step)
  current.current = step
  const pending = useRef<{ what: string; key: string } | null>(null)
  const ownChange = useRef(false)
  const liveTimer = useRef<number | null>(null)

  const keyFor = (what: string): string => {
    if (pending.current?.what !== what) pending.current = { what, key: newIdempotencyKey() }
    return pending.current.key
  }

  const ended = useCallback(
    (problem: TaskProblem): boolean => {
      if (problem.kind !== 'signedOut') return false
      void sessionEnded()
      return true
    },
    [sessionEnded],
  )

  const read = useCallback(async (): Promise<LineData | null> => {
    const [board, calls, line, scrap, blocks, conflicts] = await Promise.all([readBoard(api), readCalls(api), readFloorLine(api), readScrap(api), readBlocks(api), readConflicts(api)])
    const failed = [board, calls, line, scrap, blocks, conflicts].flatMap((answer) => (answer.ok ? [] : [answer.problem]))
    if (failed.some((problem) => ended(problem))) return null
    if (!board.ok) {
      const kept = KEPT.get('line')
      if (kept && away(board.problem)) {
        setData({ value: kept.value, asOf: kept.asOf })
        setStep((now) => (now.kind === 'loading' ? { kind: 'now' } : now))
        return kept.value
      }
      const noLine = board.problem.kind === 'invalid' || (board.problem.kind === 'refused' && board.problem.code === 'NO_LINE') || board.problem.kind === 'notFound'
      const problem = board.problem
      setStep((now) => (now.kind === 'loading' || now.kind === 'now' ? (noLine ? { kind: 'noLine' } : { kind: 'problem', problem }) : now))
      return null
    }
    const lineId = board.value.line.id
    const next: LineData = {
      board: board.value,
      calls: value(calls),
      line: value(line),
      waiting: waitingItems(value(scrap)?.rows ?? [], value(blocks)?.blocks ?? [], value(conflicts)?.conflicts ?? [], lineId),
      waitingUnknown: !scrap.ok || !blocks.ok || !conflicts.ok,
      tiles: value(scrap)?.refusalTiles ?? [],
      decisions: value(conflicts)?.decisions ?? [],
    }
    KEPT.keep('line', next)
    setData({ value: next, asOf: null })
    setStep((now) => (now.kind === 'loading' ? { kind: 'now' } : now))
    return next
  }, [api, ended])

  useEffect(() => {
    if (me) void read()
  }, [me, online, read])

  useEffect(() => {
    if (!me || !online) return
    const again = () => {
      if (document.visibilityState === 'visible') void read()
    }
    const timer = window.setInterval(again, REREAD_MS)
    document.addEventListener('visibilitychange', again)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', again)
    }
  }, [me, online, read])

  const soon = useCallback(() => {
    if (liveTimer.current !== null) return
    liveTimer.current = window.setTimeout(() => {
      liveTimer.current = null
      void read()
    }, LIVE_PAUSE_MS)
  }, [read])
  useEffect(
    () => () => {
      if (liveTimer.current !== null) window.clearTimeout(liveTimer.current)
    },
    [],
  )
  useLiveChanges({ onChange: (change) => (LIVE.has(change.type) ? soon() : undefined), onReconnect: soon }, Boolean(me) && online)

  // Rows never move under the finger: what arrives waits behind "2 new · Show"; the lead's own decision shows at once.
  const callRows = useFloorListUpdates(data?.value.calls?.calls ?? null, { key: (call) => call.id, version: (call) => call.status })
  const waitingRows = useFloorListUpdates(data?.value.waiting ?? null, { key: waitingKey, version: waitingVersion })
  const showCalls = callRows.show
  const showWaiting = waitingRows.show
  useEffect(() => {
    if (!ownChange.current) return
    ownChange.current = false
    showCalls()
    showWaiting()
  }, [data, showCalls, showWaiting])

  const answers = useMemo(() => queuedAnswers(queueSnapshot.items), [queueSnapshot.items])
  // The office recorded a saved answer: the list follows.
  const answering = useRef(0)
  useEffect(() => {
    if (answers.length < answering.current) soon()
    answering.current = answers.length
  }, [answers.length, soon])

  // ---- Calls -------------------------------------------------------------------------------------------------------------

  const answer = async (step: 'ON_THE_WAY' | 'SOLVED') => {
    const call = selectedCall(callRows.rows ?? [], picked)
    if (!call) return
    try {
      await queue.enqueue(CALL_ANSWER, answerPayload(call.id, step))
      feedback('success')
      ownChange.current = true
    } catch {
      feedback('error')
    }
  }

  // ---- Waiting for you ---------------------------------------------------------------------------------------------------

  const openItem = (item: WaitingItem) => setStep({ kind: 'decide', item, stage: 'look' })

  const afterDecision = async (item: WaitingItem) => {
    pending.current = null
    feedback('success')
    ownChange.current = true
    const fresh = await read()
    const next = fresh ? nextItem(fresh.waiting, item) : null
    setStep(next ? { kind: 'decide', item: next, stage: 'look', done: true } : { kind: 'now', done: 'decided' })
  }

  const act = async (item: WaitingItem, what: DecideAct, pinJustProved = false): Promise<void> => {
    const shown = current.current
    if (shown.kind !== 'decide') return
    const signs = what.type === 'approve' || (what.type === 'reject' && item.kind === 'block') || (what.type === 'keep' && (data?.value.decisions.find((entry) => entry.decision === 'KEEP_RECORDED')?.signs ?? true))
    if (signs && !pinJustProved && !steppedUp(stepUntil) && !steppedUp(me?.session.stepUpUntil)) return setStep({ ...shown, stage: 'pin', act: what, pinProblem: null, problem: null })
    setStep({ ...shown, busy: true, problem: null })
    const key = keyFor(`${what.type}:${waitingKey(item)}`)
    const done =
      item.kind === 'scrap'
        ? what.type === 'approve'
          ? await approveScrap(api, item.row, key)
          : await refuseScrap(api, item.row, what.type === 'reject' ? what.tile : '', what.type === 'reject' ? what.words : null, key)
        : item.kind === 'block'
          ? what.type === 'approve'
            ? await approveBlock(api, item.row, key)
            : await rejectBlock(api, item.row, what.type === 'reject' ? (what.words ?? '') : '', key)
          : await decideConflict(api, item.row, what.type === 'keep' ? 'KEEP_RECORDED' : 'SEND_TO_OFFICE', what.type === 'keep' || what.type === 'send' ? what.reason : '', key)
    if (done.ok) return afterDecision(item)
    if (ended(done.problem)) return
    if (done.problem.kind === 'stepUp') return setStep({ ...shown, busy: false, stage: 'pin', act: what, pinProblem: null })
    feedback('error')
    setStep({ ...shown, busy: false, stage: 'look', problem: done.problem })
  }

  const pin = async (value: string) => {
    const shown = current.current
    if (shown.kind === 'decide') {
      if (!shown.act) return
      setStep({ ...shown, busy: true, pinProblem: null })
      const proved = await floorStepUp(api, value)
      if (!proved.ok) {
        if (proved.problem === 'signedOut') return void sessionEnded()
        feedback('error')
        return setStep({ ...shown, busy: false, pinProblem: proved.problem })
      }
      setStepUntil(proved.until)
      setStep({ ...shown, busy: false })
      return act(shown.item, shown.act, true)
    }
    if (shown.kind === 'behalf' && shown.stage === 'override') {
      const held = overrideHeld(shown.override)
      if (held || !shown.report) return
      setStep({ ...shown, busy: true, problem: null })
      const done = await overrideOnBehalf(api, overrideBody(shown.report, shown.override, value), keyFor(`override:${String(shown.report.clientScanId)}`))
      if (!done.ok) {
        if (ended(done.problem)) return
        feedback('error')
        return setStep({ ...shown, busy: false, problem: done.problem })
      }
      pending.current = null
      feedback('success')
      setStep({ ...shown, busy: false, stage: 'done', entered: { scanId: done.value.scan.id, clientScanId: String(shown.report.clientScanId) }, problem: null })
    }
  }

  // ---- Reassign ----------------------------------------------------------------------------------------------------------

  const openReassign = async (station: string, assignmentId: string) => {
    const row = data?.value.line?.stations.find((entry) => entry.code === station)?.reassign.find((entry) => entry.assignmentId === assignmentId)
    if (!row) return
    setStep({ kind: 'reassign', station, row, people: null, chosen: null, reason: '' })
    const answer = await readOperators(api, row.assignmentId)
    const now = current.current
    if (now.kind !== 'reassign' || now.row.assignmentId !== row.assignmentId) return
    if (!answer.ok) {
      if (ended(answer.problem)) return
      return setStep({ ...now, problem: answer.problem })
    }
    setStep({ ...now, people: answer.value })
  }

  const sendReassign = async (workerId: string, reason: string | null) => {
    const shown = current.current
    if (shown.kind !== 'reassign') return
    setStep({ ...shown, busy: true, problem: null })
    const done = await reassign(api, shown.row, workerId, reason, keyFor(`reassign:${shown.row.assignmentId}:${workerId}`))
    if (!done.ok) {
      if (ended(done.problem)) return
      feedback('error')
      const chosen = shown.people?.operators.find((entry) => entry.workerId === workerId) ?? null
      return setStep({ ...shown, busy: false, chosen: done.problem.kind === 'refused' && done.problem.code === 'OVERRIDE_REASON_NEEDED' ? chosen : shown.chosen, problem: done.problem })
    }
    pending.current = null
    feedback('success')
    ownChange.current = true
    await read()
    setStep({ kind: 'now', done: 'reassigned' })
  }

  // ---- the handover note -------------------------------------------------------------------------------------------------

  const openHandover = async () => {
    const lineId = data?.value.board?.line.id
    if (!lineId) return
    const kept = NOTES.get(lineId)
    setStep({ kind: 'handover', lineId, shift: data?.value.line?.shift ?? '', note: kept?.value ?? null, draft: kept ? draftOfNote(kept.value.current) : EMPTY_HANDOVER, asOf: kept?.asOf ?? null })
    const answer = await readHandover(api, lineId)
    const now = current.current
    if (now.kind !== 'handover') return
    if (!answer.ok) {
      if (ended(answer.problem)) return
      return
    }
    NOTES.keep(lineId, answer.value)
    setStep({ ...now, shift: answer.value.shift, note: answer.value, draft: now.draft === EMPTY_HANDOVER || now.note ? draftOfNote(answer.value.current) : now.draft, asOf: null })
  }

  const sendHandover = async () => {
    const shown = current.current
    if (shown.kind !== 'handover' || handoverHeld(shown.draft)) return
    try {
      const item = await queue.enqueue(HANDOVER_WRITE, handoverPayload(shown.lineId, shown.shift, shown.draft, shown.note?.current ?? null))
      feedback('success')
      setStep({ kind: 'now', done: 'handover', queued: item.clientEventId })
    } catch {
      feedback('error')
      setStep({ ...shown, problem: { kind: 'unavailable' } })
    }
  }

  // ---- Scan on behalf ----------------------------------------------------------------------------------------------------

  const openBehalf = async () => {
    const kept = OPTIONS.get('options')
    if (kept) setStep({ kind: 'behalf', stage: 'station', options: kept.value, draft: EMPTY_BEHALF, override: EMPTY_OVERRIDE })
    else setStep({ kind: 'loading' })
    const answer = await readBehalfOptions(api)
    if (!answer.ok) {
      if (ended(answer.problem)) return
      if (!kept) setStep({ kind: 'problem', problem: answer.problem })
      return
    }
    OPTIONS.keep('options', answer.value)
    setStep((now) => (now.kind === 'loading' ? { kind: 'behalf', stage: 'station', options: answer.value, draft: EMPTY_BEHALF, override: EMPTY_OVERRIDE } : now.kind === 'behalf' ? { ...now, options: answer.value } : now))
  }

  const scanBundle = async (code: string) => {
    const shown = current.current
    if (shown.kind !== 'behalf') return
    setStep({ ...shown, busy: true, problem: null, scanned: code })
    const answer = await fetchCard(api, code)
    const now = current.current
    if (now.kind !== 'behalf') return
    if (!answer.ok) {
      if (ended(answer.problem)) return
      feedback('error')
      return setStep({ ...now, busy: false, problem: answer.problem })
    }
    const card = answer.value
    if (card.refusal) {
      feedback('error')
      return setStep({ ...now, busy: false, problem: { kind: 'refused', code: card.refusal.code, message: card.refusal.message, fix: null } })
    }
    const open = openOperations(card)
    if (open.length === 0) {
      feedback('error')
      return setStep({ ...now, busy: false, problem: { kind: 'refused', code: 'NOTHING_OPEN', message: '', fix: null } })
    }
    feedback('success')
    const draft: BehalfDraft = { ...now.draft, card, operationId: open.length === 1 ? open[0]!.id : null, scrap: {}, rework: {} }
    if (open.length > 1) return setStep({ ...now, busy: false, stage: 'operation', draft, problem: null })
    setStep({ ...now, busy: false, stage: 'counts', draft: { ...draft, good: expectedOf(draft) }, problem: null })
  }

  const sendEntry = async () => {
    const shown = current.current
    if (shown.kind !== 'behalf' || shown.busy || behalfHeld(shown.draft, shown.options)) return
    const body = behalfPayload(shown.draft, shown.options.subject)
    const saveOnTablet = async () => {
      const item = await queue.enqueue(SCAN_ON_BEHALF, body)
      feedback('success')
      setStep({ ...shown, busy: false, stage: 'done', queued: item.clientEventId, problem: null })
    }
    try {
      if (!online) return await saveOnTablet()
      const clientScanId = newIdempotencyKey()
      const report = { ...body, clientScanId }
      setStep({ ...shown, busy: true, problem: null })
      const done = await reportOnBehalf(api, report, clientScanId)
      if (done.ok) {
        feedback('success')
        return setStep({ ...shown, busy: false, stage: 'done', entered: { scanId: done.value.scan.id, clientScanId }, problem: null })
      }
      if (ended(done.problem)) return
      if (away(done.problem)) return await saveOnTablet()
      feedback('error')
      if (done.problem.kind === 'refused' && isOverridable(done.problem.code)) return setStep({ ...shown, busy: false, stage: 'override', report, override: EMPTY_OVERRIDE, problem: done.problem })
      setStep({ ...shown, busy: false, problem: done.problem })
    } catch {
      feedback('error')
      setStep({ ...shown, busy: false, problem: { kind: 'unavailable' } })
    }
  }

  const undo = async () => {
    const shown = current.current
    if (shown.kind !== 'behalf' || !shown.entered) return
    setStep({ ...shown, busy: true, problem: null })
    const done = await undoEntry(api, shown.entered.scanId, newIdempotencyKey(), newIdempotencyKey())
    if (!done.ok) {
      if (ended(done.problem)) return
      feedback('error')
      return setStep({ ...shown, busy: false, problem: done.problem })
    }
    feedback('success')
    setStep({ ...shown, busy: false, undone: true, problem: null })
  }

  // ---- back --------------------------------------------------------------------------------------------------------------

  const toNow = () => {
    setStep({ kind: 'now' })
    void read()
  }

  const back = () => {
    const shown = current.current
    switch (shown.kind) {
      case 'decide':
        if (shown.stage === 'look') return toNow()
        return setStep({ ...shown, stage: shown.stage === 'pin' && shown.act?.type === 'reject' ? 'reject' : 'look', act: null, problem: null })
      case 'behalf': {
        const before = { station: null, person: 'station', scan: shown.options.subject === 'WORKER' ? 'person' : 'station', operation: 'scan', counts: 'scan', reason: 'counts', override: 'reason', done: null } as const
        const to = before[shown.stage]
        return to ? setStep({ ...shown, stage: to, problem: null }) : toNow()
      }
      case 'reassign':
        return shown.chosen ? setStep({ ...shown, chosen: null, problem: null }) : toNow()
      case 'now':
      case 'loading':
      case 'noLine':
      case 'problem':
        return router.push('/floor')
      default:
        return toNow()
    }
  }

  const onAction = (action: LineAction) => {
    const shown = current.current
    switch (action.type) {
      case 'back':
        return back()
      case 'home':
        return router.push('/floor')
      case 'showCalls':
        return callRows.show()
      case 'showWaiting':
        return waitingRows.show()
      case 'pickCall':
        return setPicked(action.id)
      case 'onMyWay':
        return void answer('ON_THE_WAY')
      case 'solved':
        return void answer('SOLVED')
      case 'open':
        return openItem(action.item)
      case 'stage':
        if (shown.kind === 'decide') setStep({ ...shown, stage: action.stage, tile: null, words: '', problem: null })
        return
      case 'tile':
        if (shown.kind === 'decide') setStep({ ...shown, tile: action.code })
        return
      case 'words':
        if (shown.kind === 'decide') setStep({ ...shown, words: action.text })
        else if (shown.kind === 'reassign') setStep({ ...shown, reason: action.text })
        else if (shown.kind === 'behalf' && shown.stage === 'override') setStep({ ...shown, override: { ...shown.override, note: action.text } })
        else if (shown.kind === 'behalf') setStep({ ...shown, draft: { ...shown.draft, note: action.text } })
        else if (shown.kind === 'handover') setStep({ ...shown, draft: { ...shown.draft, text: action.text } })
        return
      case 'approve':
        if (shown.kind === 'decide') void act(shown.item, { type: 'approve' })
        return
      case 'reject': {
        if (shown.kind !== 'decide') return
        const tile = data?.value.tiles.find((entry) => entry.code === shown.tile) ?? null
        if (rejectHeld({ item: shown.item, tile, words: shown.words ?? '' })) return
        return void act(shown.item, { type: 'reject', tile: shown.tile ?? '', words: shown.words?.trim() || null })
      }
      case 'conflict':
        if (shown.kind === 'decide' && shown.tile) void act(shown.item, shown.stage === 'keep' ? { type: 'keep', reason: shown.tile } : { type: 'send', reason: shown.tile })
        return
      case 'pin':
        return void pin(action.pin)
      case 'reassign':
        return void openReassign(action.station, action.assignmentId)
      case 'person': {
        if (shown.kind === 'reassign') {
          const person = shown.people?.operators.find((entry) => entry.workerId === action.id)
          if (!person || reassignHeld(person) !== null) return
          if (reassignNeedsReason(person)) return setStep({ ...shown, chosen: person, reason: '', problem: null })
          return void sendReassign(person.workerId, null)
        }
        if (shown.kind === 'behalf') setStep({ ...shown, draft: { ...shown.draft, personId: action.id }, stage: 'scan', problem: null })
        return
      }
      case 'sendReassign':
        if (shown.kind === 'reassign' && shown.chosen) void sendReassign(shown.chosen.workerId, shown.reason.trim() || null)
        return
      case 'handover':
        return void openHandover()
      case 'topic':
        if (shown.kind === 'handover') setStep({ ...shown, draft: toggleTopic(shown.draft, action.topic) })
        return
      case 'sendHandover':
        return void sendHandover()
      case 'behalf':
        return void openBehalf()
      case 'station':
        if (shown.kind === 'behalf') setStep({ ...shown, draft: { ...shown.draft, stationId: action.id }, stage: shown.options.subject === 'WORKER' ? 'person' : 'scan', problem: null })
        return
      case 'scan':
        if (shown.kind === 'behalf' && shown.stage === 'override') setStep({ ...shown, override: { ...shown.override, badge: action.code } })
        else void scanBundle(action.code)
        return
      case 'operation':
        if (shown.kind === 'behalf') {
          const draft = { ...shown.draft, operationId: action.id }
          setStep({ ...shown, stage: 'counts', draft: { ...draft, good: expectedOf(draft) } })
        }
        return
      case 'good':
        if (shown.kind === 'behalf') setStep({ ...shown, draft: { ...shown.draft, good: action.value ?? 0 } })
        return
      case 'defects':
        if (shown.kind === 'behalf') setStep({ ...shown, draft: withDefects(shown.draft, action.kind, action.counts) })
        return
      case 'toReason':
        if (shown.kind === 'behalf') setStep({ ...shown, stage: 'reason', problem: null })
        return
      case 'behalfReason':
        if (shown.kind === 'behalf') setStep({ ...shown, draft: { ...shown.draft, reason: action.code } })
        return
      case 'overrideReason':
        if (shown.kind === 'behalf') setStep({ ...shown, override: { ...shown.override, reason: action.code } })
        return
      case 'sendEntry':
        return void sendEntry()
      case 'undoEntry':
        return void undo()
      case 'another':
        return void openBehalf()
    }
  }

  useFloorKeys({ escape: back })

  // A saved note or entry follows its two ticks on the screen it left.
  const saved = step.kind === 'now' && step.queued ? queuedView(queueSnapshot, step.queued) : step.kind === 'behalf' && step.queued ? queuedView(queueSnapshot, step.queued) : null

  if (!me) return null
  return (
    <LineViewScreen
      model={{
        frame,
        can,
        online,
        step,
        signer: me.worker.displayName,
        board: data?.value.board ?? null,
        line: data?.value.line ?? null,
        canAnswer: data?.value.calls?.canAnswer ?? false,
        calls: callRows.rows ?? [],
        callsPending: callRows.pending,
        callsUnknown: data !== null && data.value.calls === null,
        picked: selectedCall(callRows.rows ?? [], picked)?.id ?? null,
        answers,
        waiting: waitingRows.rows ?? [],
        waitingPending: waitingRows.pending,
        waitingUnknown: data?.value.waitingUnknown ?? false,
        tiles: data?.value.tiles ?? [],
        decisions: data?.value.decisions ?? [],
        asOf: data?.asOf ?? null,
        ticks: saved?.ticks ?? null,
      }}
      onAction={onAction}
      onFrame={onFrame}
    />
  )
}
