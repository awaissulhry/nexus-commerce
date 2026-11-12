'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { zxingCamera } from '../../camera'
import { useFloor, useFloorRouter } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { queuedView } from '../shared/queued'
import type { TaskProblem } from '../shared/task-api'
import { stepOrKeep } from '../mywork/warehouse/api'
import { changedTasks, codeOfTask, moveTasks, type WarehouseTask } from '../mywork/warehouse/model'
import { useTaskInbox } from '../mywork/warehouse/use-inbox'
import { forgetHand, keptHand, moveOrKeep, scanForMove, undoMove } from './api'
import { takeHandedTask } from './handoff'
import { fromOf, moveBody, padOf, placeActOf, placeHeld, taskOfMove, undoLeftMs, undoOpen, type MoveLast, type MoveScan } from './model'
import { MoveView, type MoveAction, type MoveProblem, type MoveStep } from './view/MoveView'

/**
 * The live SCR-177 (`/floor/move`; B-W2b-308 on B-W2b-292's API): Move & put away at the warehouse. A label scanned here, on Home
 * (a lot, a hide, a roll or a remnant at the warehouse: tasks/routes.ts) or handed from My work's task opens "In your hands"
 * (`GET /inventory/putaway/scan`); the scan of the place's label IS the move, online first, else kept in the tablet's queue
 * with the same body (inventory.putAway | inventory.binMove; a hold's quarantine move: inventory.task.done with the place).
 * The strip under the scan field says where the last move stands (two ticks) and offers Undo for its 2 minutes while online.
 * What waits to be moved is the person's inbox (put-aways, moves, quarantine moves), read on view, live and on a beat.
 * Offline: what this tablet read in this visit opens "as of"; a code it never read moves on its label alone (the office checks
 * it when the move is sent).
 */

export function FloorMove() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.move', { showHome: true })
  const { me, api, online, sessionEnded, queue, queueSnapshot } = store
  const may = Boolean(me?.permissions.includes('floor.work') && me.permissions.includes('inventory.transfer'))
  const deviceId = store.device?.device.id ?? null
  const workerId = me?.worker.id ?? null
  const inbox = useTaskInbox({ api, online, workerId, allowed: may, onSignedOut: () => void sessionEnded() })

  const [step, setStep] = useState<MoveStep>(may ? { kind: 'what' } : { kind: 'noPermission' })
  const [scan, setScan] = useState<MoveScan | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [handAsOf, setHandAsOf] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const [value, setValue] = useState<number | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [fromTask, setFromTask] = useState<WarehouseTask | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<MoveProblem | null>(null)
  const [last, setLast] = useState<MoveLast | null>(null)
  const [undoBusy, setUndoBusy] = useState(false)
  const [, setClock] = useState(0)
  const started = useRef(false)

  const fail = useCallback(
    (found: TaskProblem, facts: Omit<MoveProblem, 'problem'>) => {
      if (found.kind === 'signedOut') return void sessionEnded()
      feedback(found.kind === 'offline' || found.kind === 'unavailable' ? 'warning' : 'error')
      setProblem({ problem: found, ...facts })
    },
    [feedback, sessionEnded],
  )

  const clearHand = useCallback(() => {
    setScan(null)
    setCode(null)
    setHandAsOf(null)
    setPicked(null)
    setValue(null)
  }, [])

  /** In your hands: the pad starts at all that lies where it is taken from. */
  const holdInHand = useCallback((found: MoveScan | null, raw: string, asOf: string | null, forTask: string | null) => {
    setScan(found)
    setCode(raw)
    setHandAsOf(asOf)
    setPicked(null)
    setTaskId(forTask)
    setValue(found ? (padOf(found.hand, fromOf(found, null, forTask))?.max ?? null) : null)
    setStep({ kind: 'hand' })
  }, [])

  const lookUp = useCallback(
    async (raw: string, forTask: string | null) => {
      setProblem(null)
      const offlineHand = () => {
        const kept = keptHand(raw)
        holdInHand(kept?.value ?? null, raw, kept?.asOf ?? null, forTask)
        feedback(kept ? 'success' : 'warning')
      }
      if (!online) return offlineHand()
      setStep({ kind: 'reading', code: raw })
      const answer = await scanForMove(api, raw)
      if (answer.ok) {
        feedback('success')
        return holdInHand(answer.value, raw, null, forTask)
      }
      if (answer.problem.kind === 'offline') return offlineHand()
      setStep(fromTask ? { kind: 'task', task: fromTask } : { kind: 'what' })
      if (answer.problem.kind === 'notFound' || answer.problem.kind === 'invalid') return fail({ kind: 'refused', code: 'NOT_STOCK', message: '', fix: null }, { code: raw })
      return fail(answer.problem, { code: raw })
    },
    [api, fail, feedback, fromTask, holdInHand, online],
  )

  /** Back to "Scan what you move" after a move: the list read again, the facts of what moved forgotten. */
  const finished = useCallback(
    (moved: string) => {
      forgetHand(moved)
      clearHand()
      setTaskId(null)
      setFromTask(null)
      setStep({ kind: 'what' })
      feedback('success')
      void inbox.read(true)
    },
    [clearHand, feedback, inbox],
  )

  /** A hold's quarantine move: the quarantine place's scan does its task (the office's confirm). */
  const quarantine = useCallback(
    async (task: WarehouseTask, placeCode: string, what: string) => {
      setBusy(true)
      try {
        const outcome = await stepOrKeep(api, queue, online, deviceId, 'done', { taskId: task.id, version: task.version, placeCode })
        const base = { kind: 'quarantined' as const, code: what, purpose: null, quantity: null, uom: null, from: null, to: placeCode.trim().toUpperCase(), moveId: null, at: null }
        if (outcome.kept) {
          setLast({ ...base, ticks: 'saved', clientEventId: outcome.kept.clientEventId })
          return finished(what)
        }
        if (outcome.answer.ok) {
          const done = outcome.answer.value
          setLast({ ...base, to: done.task.to?.code ?? base.to, ticks: 'recorded', clientEventId: null, moved: done.moved ?? [], stays: done.stays ?? [] })
          return finished(what)
        }
        fail(outcome.answer.problem, { code: what, place: placeCode, asked: task.to?.code ?? null })
      } finally {
        setBusy(false)
      }
    },
    [api, deviceId, fail, finished, online, queue],
  )

  /** The place's label scanned: the move posts on the scan (the bin label is the confirmation). */
  const place = useCallback(
    async (placeCode: string) => {
      if (busy || !code) return
      const from = scan ? fromOf(scan, picked, taskId) : null
      const pad = scan ? padOf(scan.hand, from) : null
      if (placeHeld(scan, from, pad, value)) return void feedback('warning')
      const act = placeActOf(scan, from)
      if (act.kind === 'quarantine') return quarantine(act.task, placeCode, code)
      const task = scan ? taskOfMove(scan, from, taskId) : null
      const body = moveBody({ code, placeCode, hand: scan?.hand ?? null, from, pad, value, taskId: task?.id ?? taskId })
      setBusy(true)
      try {
        const outcome = await moveOrKeep(api, queue, online, deviceId, act.purpose, body)
        const base = { kind: 'moved' as const, code, purpose: act.purpose, quantity: body.quantity ?? from?.onHand ?? null, uom: scan?.hand.uom ?? null, from: from?.code ?? null, to: placeCode.trim().toUpperCase() }
        if (outcome.kept) {
          setLast({ ...base, ticks: 'saved', clientEventId: outcome.kept.clientEventId, moveId: null, at: null })
          return finished(code)
        }
        if (outcome.answer.ok) {
          const moved = outcome.answer.value
          setLast({ ...base, from: moved.from.code, to: moved.to.code, ticks: 'recorded', clientEventId: null, moveId: moved.moveIds[0] ?? null, at: new Date().toISOString() })
          return finished(code)
        }
        fail(outcome.answer.problem, { code, place: placeCode, asked: null })
      } finally {
        setBusy(false)
      }
    },
    [api, busy, code, deviceId, fail, feedback, finished, online, picked, quarantine, queue, scan, taskId, value],
  )

  const undo = useCallback(async () => {
    if (!last || !undoOpen(last, new Date()) || !online || undoBusy || !last.moveId) return
    setUndoBusy(true)
    const answer = await undoMove(api, last.moveId, newIdempotencyKey())
    setUndoBusy(false)
    if (!answer.ok) return fail(answer.problem, { code: last.code })
    forgetHand(last.code)
    setLast({ ...last, kind: 'undone', clientEventId: null })
    feedback('success')
    void inbox.read(true)
  }, [api, fail, feedback, inbox, last, online, undoBusy])

  // A move kept on the tablet: once the office recorded it, its move id (for Undo) and its time; a refusal says so.
  const queued = last?.clientEventId ? queuedView(queueSnapshot, last.clientEventId) : null
  const queuedTicks = queued?.ticks ?? null
  useEffect(() => {
    if (!queued || !last) return
    if (queued.ticks === 'recorded' && last.ticks !== 'recorded') {
      const result = queued.item?.result
      setLast({ ...last, ticks: 'recorded', moveId: result && result.type === 'StockMove' ? result.id : null, at: queued.item?.recordedAt ?? new Date().toISOString() })
    } else if (queued.ticks === 'refused' && last.ticks !== 'refused') setLast({ ...last, ticks: 'refused', refusal: queued.refusal?.code ?? null })
    // Only the queue's word on this item moves it on.
  }, [queuedTicks])

  // The Undo button goes when its 2 minutes are over.
  useEffect(() => {
    const left = undoLeftMs(last, new Date())
    if (left === null) return
    const timer = window.setTimeout(() => setClock((value) => value + 1), left + 50)
    return () => window.clearTimeout(timer)
  }, [last])

  const openTask = useCallback((task: WarehouseTask) => {
    setProblem(null)
    setLast(null)
    setFromTask(task)
    setStep({ kind: 'task', task })
  }, [])

  const back = useCallback(() => {
    setProblem(null)
    if (step.kind === 'hand' && fromTask) {
      clearHand()
      return setStep({ kind: 'task', task: fromTask })
    }
    if (step.kind === 'hand' || step.kind === 'task' || step.kind === 'reading') {
      clearHand()
      setTaskId(null)
      setFromTask(null)
      return setStep({ kind: 'what' })
    }
    router.push('/floor')
  }, [clearHand, fromTask, router, step.kind])

  const onScan = useCallback(
    async (raw: string) => {
      if (!me || !may) return
      const read = readScan(raw, me.scanTag)
      if (read.kind === 'badge') {
        const refused = await store.switchTo(read.code)
        if (refused) fail({ kind: 'refused', code: 'BADGE', message: '', fix: null }, { code: null })
        return
      }
      const scanned = raw.trim()
      if (scanned === '' || me.notice.blocksScans) return
      setProblem(null)
      if (step.kind === 'hand') return place(scanned)
      if (step.kind === 'reading' || busy) return
      if (step.kind === 'task') {
        const task = step.task
        // A hold's quarantine move that names no single lot or hide: its place is the only scan.
        if (task.kind === 'QUARANTINE' && !codeOfTask(task)) return quarantine(task, scanned, '')
        return lookUp(scanned, task.id)
      }
      setLast(null)
      return lookUp(scanned, null)
    },
    [busy, fail, lookUp, may, me, place, quarantine, step, store],
  )

  // A task handed from My work opens its card; a label handed from Home opens what it names.
  useEffect(() => {
    if (started.current || !me || !may) return
    started.current = true
    const task = takeHandedTask()
    if (task) return openTask(task)
    const handed = store.takeScan()
    if (handed) void lookUp(handed, null)
  }, [lookUp, may, me, openTask, store])

  const onAction = (action: MoveAction) => {
    switch (action.type) {
      case 'scan':
        return void onScan(action.code)
      case 'openTask': {
        const task = moveTasks(inbox.shown).find((entry) => entry.id === action.taskId)
        return task ? openTask(task) : undefined
      }
      case 'pickFrom': {
        if (!scan) return
        setPicked(action.locationId)
        const from = fromOf(scan, action.locationId, taskId)
        return setValue(padOf(scan.hand, from)?.max ?? null)
      }
      case 'pad':
        return setValue(action.value)
      case 'undo':
        return void undo()
      case 'back':
        return back()
      case 'dismiss':
        setProblem(null)
        if (step.kind === 'reading') setStep(fromTask ? { kind: 'task', task: fromTask } : { kind: 'what' })
        return
      case 'startAgain':
        setProblem(null)
        clearHand()
        setTaskId(null)
        setFromTask(null)
        return setStep({ kind: 'what' })
      case 'retry':
        setProblem(null)
        if (step.kind !== 'hand' && code) return void lookUp(code, taskId)
        return
      case 'showTasks':
        return inbox.showFresh()
    }
  }

  useFloorKeys({
    enter: problem ? () => onAction({ type: 'dismiss' }) : null,
    escape: problem ? () => onAction({ type: 'dismiss' }) : back,
  })

  if (!me) return null
  const now = new Date()
  const shownTicks = last && queuedTicks && last.ticks !== 'recorded' && last.ticks !== 'refused' ? queuedTicks : (last?.ticks ?? null)
  const shownLast = last && shownTicks ? { ...last, ticks: shownTicks } : last
  return (
    <MoveView
      model={{
        frame,
        online,
        held: me.notice.blocksScans,
        step: may ? step : { kind: 'noPermission' },
        tasks: inbox.shown ? moveTasks(inbox.shown) : null,
        tasksAsOf: inbox.asOf,
        tasksProblem: inbox.shown ? null : inbox.problem,
        tasksChanged: inbox.fresh && inbox.shown ? changedTasks({ ...inbox.shown, tasks: moveTasks(inbox.shown) }, { ...inbox.fresh, tasks: moveTasks(inbox.fresh) }) : 0,
        tasksMore: inbox.shown?.more ?? false,
        scan,
        code,
        handAsOf,
        picked,
        value,
        taskId,
        busy,
        problem,
        last: shownLast,
        undo: undoOpen(shownLast, now) ? (undoBusy ? 'busy' : 'open') : null,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
