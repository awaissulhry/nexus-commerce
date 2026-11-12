'use client'

import { useCallback, useEffect, useState } from 'react'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { zxingCamera } from '../../../camera'
import { useFloor, useFloorRouter } from '../../../FloorApp'
import { useFloorKeys } from '../../../keys'
import { homeTiles, modeOf } from '../../../model'
import { readScan } from '../../../scan/scan-model'
import { queuedView } from '../../shared/queued'
import { TASK_ROUTES, taskForScan } from '../../routes'
import { handTaskToMove } from '../../move/handoff'
import { handWorkOrderToPick } from '../../issue/picklist/handoff'
import { stepOrKeep } from './api'
import { changedTasks, codeOfTask, doneHeld, screenOf, stepsStill, withStep, withSteps, type OwnStep, type StepKind, type WarehouseTask } from './model'
import { useTaskInbox } from './use-inbox'
import { InboxView, type InboxAction, type InboxLine, type InboxStep } from './view/InboxView'

/**
 * The live SCR-089 at the warehouse (`/floor/mywork` on a tablet with no station; B-W2b-308 on B-W2b-292's API): the person's
 * warehouse task inbox (`GET /inventory/tasks/inbox`) read on view, live (inventory.warehouse_task_changed), every 30 s while in
 * view and when the network returns; a fresher list waits behind "List changed · Show". Take, Give back and Done are one tap,
 * online first, else kept in the tablet's queue (inventory.task.take | giveBack | done): the list shows them at once and the
 * line under the status says where they stand (two ticks). The main action opens the screen that does the task: Move & put away
 * with the task's card, Receive, Pick & issue; a count is done by its tap. A scan opens the job with its label, as Home does.
 */

export function FloorWarehouseInbox() {
  const store = useFloor()
  const router = useFloorRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.mywork', { showHome: true })
  const { me, api, online, sessionEnded, queue, queueSnapshot } = store
  const allowed = Boolean(me?.permissions.includes('floor.work'))
  const workerId = me?.worker.id ?? null
  const deviceId = store.device?.device.id ?? null
  const inbox = useTaskInbox({ api, online, workerId, allowed, onSignedOut: () => void sessionEnded() })
  const [step, setStep] = useState<InboxStep>(allowed ? { kind: 'list' } : { kind: 'noPermission' })
  const [steps, setSteps] = useState<OwnStep[]>([])
  const [line, setLine] = useState<(InboxLine & { clientEventId: string | null }) | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Another person on the tablet: nothing of the last one's steps.
  useEffect(() => {
    setSteps([])
    setLine(null)
    setStep(allowed ? { kind: 'list' } : { kind: 'noPermission' })
  }, [workerId, allowed])

  // The office's list now says what this tablet did: the step drops (its row shows as the office has it).
  useEffect(() => {
    setSteps((current) => {
      const still = stepsStill(current, inbox.shown)
      return still.length === current.length ? current : still
    })
  }, [inbox.shown])

  const shown = withSteps(inbox.shown, steps)
  const taskOf = (taskId: string): WarehouseTask | null => shown?.tasks.find((task) => task.id === taskId) ?? inbox.shown?.tasks.find((task) => task.id === taskId) ?? null

  const takeStep = useCallback(
    async (task: WarehouseTask, kind: StepKind) => {
      if (busy) return
      if (kind === 'done' && doneHeld(task)) return void feedback('warning')
      setBusy(task.id)
      const title = { kind: task.kind, code: codeOfTask(task) ?? task.item?.code ?? null }
      try {
        const outcome = await stepOrKeep(api, queue, online, deviceId, kind, { taskId: task.id, version: task.version })
        if (outcome.kept) {
          setSteps((current) => withStep(current, { taskId: task.id, step: kind, at: new Date().toISOString(), clientEventId: outcome.kept.clientEventId }))
          setLine({ taskId: task.id, ...title, step: kind, ticks: 'saved', clientEventId: outcome.kept.clientEventId })
          feedback('success')
        } else if (outcome.answer.ok) {
          setSteps((current) => withStep(current, { taskId: task.id, step: kind, at: new Date().toISOString(), clientEventId: null }))
          setLine({ taskId: task.id, ...title, step: kind, ticks: 'recorded', clientEventId: null })
          feedback('success')
          void inbox.read(true)
        } else {
          const problem = outcome.answer.problem
          if (problem.kind === 'signedOut') return void sessionEnded()
          setLine({ taskId: task.id, ...title, step: kind, ticks: 'refused', clientEventId: null, refusal: problem.kind === 'refused' ? problem.code : null })
          feedback('error')
          void inbox.read(true)
        }
        if (kind === 'done') setStep({ kind: 'list' })
      } finally {
        setBusy(null)
      }
    },
    [api, busy, deviceId, feedback, inbox, online, queue, sessionEnded],
  )

  // A step kept on the tablet: its ticks from the queue; a refusal there undoes it on screen.
  const queued = line?.clientEventId ? queuedView(queueSnapshot, line.clientEventId) : null
  const queuedTicks = queued?.ticks ?? null
  useEffect(() => {
    if (!line || !queued) return
    if (queued.ticks === 'refused') {
      setSteps((current) => current.filter((entry) => entry.clientEventId !== line.clientEventId))
      setLine({ ...line, ticks: 'refused', refusal: queued.refusal?.code ?? null })
    } else if (queued.ticks === 'recorded') void inbox.read(true)
    // Only the queue's word on this step moves it on.
  }, [queuedTicks])

  const go = (task: WarehouseTask) => {
    const screen = screenOf(task.kind)
    if (!screen) return
    if (screen === 'move') handTaskToMove(task)
    // B-W2b-310: Count opens on the task's place (handed like a scan); Pick & issue on the task's work order.
    if (screen === 'count') return store.openWith(TASK_ROUTES.count, task.from?.code ?? null)
    if (screen === 'pick' && task.source?.type === 'WorkOrder') handWorkOrderToPick(task.source.id)
    router.push(TASK_ROUTES[screen])
  }

  const onScan = async (code: string) => {
    if (!me) return
    const read = readScan(code, me.scanTag)
    const mode = modeOf(me.device.station, me.device.mode)
    const tiles = homeTiles(mode, me.permissions, me.notice.blocksScans, me.device.mode)
    const task = taskForScan(mode, read, tiles, me.permissions, me.notice.blocksScans)
    if (task) return store.openWith(TASK_ROUTES[task], read.code)
    if (read.kind !== 'badge') return store.openScan(code)
    if (await store.switchTo(read.code)) feedback('error')
  }

  const onAction = (action: InboxAction) => {
    switch (action.type) {
      case 'scan':
        return void onScan(action.code)
      case 'open':
        return setStep({ kind: 'task', taskId: action.taskId })
      case 'back':
        return setStep({ kind: 'list' })
      case 'take':
      case 'giveBack':
      case 'done': {
        const task = taskOf(action.taskId)
        return task ? void takeStep(task, action.type) : undefined
      }
      case 'go': {
        const task = taskOf(action.taskId)
        return task ? go(task) : undefined
      }
      case 'show':
        return inbox.showFresh()
      case 'retry':
        return void inbox.read(true)
    }
  }

  useFloorKeys({ escape: step.kind === 'task' ? () => setStep({ kind: 'list' }) : () => router.push('/floor') })

  if (!me) return null
  const permissions = me.permissions
  const lineShown: InboxLine | null = line ? { ...line, ticks: line.ticks === 'refused' ? 'refused' : (queuedTicks ?? line.ticks) } : null
  return (
    <InboxView
      model={{
        frame,
        online,
        held: me.notice.blocksScans,
        step,
        inbox: shown,
        asOf: inbox.asOf,
        problem: inbox.shown ? null : inbox.problem,
        changed: inbox.fresh && inbox.shown ? changedTasks(inbox.shown, inbox.fresh) : 0,
        screens: { move: permissions.includes('inventory.transfer'), receive: permissions.includes('inventory.receive'), pick: permissions.includes('inventory.issue'), /* B-W2b-310 */ count: permissions.includes('inventory.counts.scan') },
        busy,
        line: lineShown,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
