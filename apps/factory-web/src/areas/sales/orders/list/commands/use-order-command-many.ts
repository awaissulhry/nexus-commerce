'use client'

import { useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { approveTask } from '../../../../home/approvals/api'
import { closeOrder, getOrder, markReady, type Order, type OrderRow } from '../../api'
import { STEP_UP_CLOSED, useStepUp } from '../../hooks'
import { closeNeedsReason, type OrderAbilities } from '../../model'
import {
  MANY_READ_AT_ONCE,
  manyGoHeld,
  manyHeld,
  manyPreview,
  manyReadOf,
  manyReceipt,
  manyTargetsOf,
  runMany,
  yesTaskOf,
  type ManyCommand,
  type ManyLine,
  type ManyTarget,
  type OrderCommandManyActions,
  type OrderCommandManyModel,
} from './model'

/**
 * F-CP-109 (customer page plan C2b, D8; 10-customer-page §3.2; lead pick, approved: ≤ 50 with ONE step-up): Mark {count} ready… · Close
 * {count}… · Confirm {count}… on the Orders sheet's bar — the order page's own commands over the ticked orders (Cancel stays one at a
 * time: each cancel shows what it stops). Opening reads each ticked order (GET /sales/orders/:id, 5 at a time: the server's wall — an
 * order out of reach is counted, never named) and runs A14's rule on each (the preview: "Runs on 6 · Not on 2: why is beside each").
 * ONE reason when one is needed (Mark ready; Close of an order not settled); Confirm N asks ONE fresh code first when a yes's rule asks
 * one (each order is named in the preview, each yes its own audit row on the server). Run: one order at a time, each with its own
 * version and Idempotency-Key; a failure never stops the rest. The result: "5 done · 1 not done" with why beside each; Run the rest
 * again reads the orders not done again (a fresh version, A14's rules again, a fresh code for Confirm N).
 */
export function useOrderCommandMany(
  api: ApiClient,
  input: {
    readonly can: OrderAbilities
    /** A run ended: the orders as their writes answered (Mark ready, Close) and the ids it ran on (read again by the host, in place). */
    readonly onDone: (answered: readonly Order[], ran: readonly string[]) => void
  },
): { model: OrderCommandManyModel | null; open: (command: ManyCommand, rows: readonly OrderRow[]) => void; actions: OrderCommandManyActions } {
  const [model, setModel] = useState<OrderCommandManyModel | null>(null)
  const current = useRef<OrderCommandManyModel | null>(null)
  const turn = useRef(0)
  const stepUp = useStepUp(api)
  const onDone = useRef(input.onDone)
  onDone.current = input.onDone

  const update = (mine: number, change: (now: OrderCommandManyModel) => OrderCommandManyModel) => {
    const now = current.current
    if (!now || mine !== turn.current) return
    const next = change(now)
    current.current = next
    setModel(next)
  }

  /** Each ticked order read, 5 at a time; each answer lands on its own line as it comes. */
  const readAll = async (mine: number, targets: readonly ManyTarget[]) => {
    const queue = [...targets]
    const worker = async () => {
      for (let target = queue.shift(); target; target = queue.shift()) {
        const id = target.id
        try {
          const order = await getOrder(api, id)
          update(mine, (now) => ({ ...now, reads: { ...now.reads, [id]: { state: 'ready', order } } }))
        } catch (error) {
          update(mine, (now) => ({ ...now, reads: { ...now.reads, [id]: manyReadOf(error) } }))
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MANY_READ_AT_ONCE, targets.length) }, worker))
  }

  const start = (command: ManyCommand, targets: readonly ManyTarget[]) => {
    const mine = ++turn.current
    const next: OrderCommandManyModel = { command, targets, reads: Object.fromEntries(targets.map((target) => [target.id, { state: 'reading' as const }])), reason: current.current?.command === command ? current.current.reason : '', phase: 'preview', progress: null, results: {}, stepUp: STEP_UP_CLOSED, can: input.can }
    current.current = next
    setModel(next)
    void readAll(mine, targets)
  }

  const open = (command: ManyCommand, rows: readonly OrderRow[]) => {
    // The bar holds these in words before the click (more than 50, the right, none in the state); never opened on them all the same.
    if (rows.length === 0 || manyHeld(command, rows, input.can)) return
    current.current = null
    start(command, manyTargetsOf(rows))
  }

  const run = async () => {
    const now = current.current
    const mine = turn.current
    if (!now || now.phase !== 'preview') return
    const preview = manyPreview(now.command, now.targets, now.reads, now.can)
    if (manyGoHeld(now.command, preview, now.reason, false)) return
    const reason = now.reason.trim()
    // Confirm N: ONE fresh code before the first yes, when a yes's rule asks one (an expired code later: "run the rest again").
    if (now.command === 'confirm' && preview.runs.some((line) => !!line.order && yesTaskOf(line.order)?.requireStepUp)) {
      try {
        await stepUp.ensureFresh('approval.stepUp')
      } catch {
        // The code's window closed (StepUpCancelled), or the code could not be asked: nothing ran; the preview stays as it was.
        return
      }
    }
    if (mine !== turn.current) return
    update(mine, (m) => ({ ...m, phase: 'running', progress: { done: 0, count: preview.runs.length }, results: {} }))
    const answered: Order[] = []
    // One order's command: its own version (as read) and its own Idempotency-Key (the route's; the yes: a key of its own).
    const one = async (line: ManyLine) => {
      const order = line.order
      if (!order) throw new Error('not read')
      if (now.command === 'ready') answered.push(await markReady(api, order.id, { version: order.version, reason }))
      else if (now.command === 'close') answered.push(await closeOrder(api, order.id, { version: order.version, ...(closeNeedsReason(order) ? { reason } : {}) }))
      else {
        const task = yesTaskOf(order)
        if (!task) throw new Error('no yes')
        await approveTask(api, { id: task.taskId, version: task.version }, null, newIdempotencyKey())
      }
    }
    await runMany(preview.runs, one, (id, result, done) => update(mine, (m) => ({ ...m, results: { ...m.results, [id]: result }, progress: { done, count: preview.runs.length } })))
    update(mine, (m) => ({ ...m, phase: 'done', progress: null }))
    onDone.current(answered, preview.runs.map((line) => line.target.id))
  }

  const actions: OrderCommandManyActions = {
    onReason: (reason) => update(turn.current, (m) => (m.phase === 'preview' ? { ...m, reason } : m)),
    onRun: () => void run(),
    onAgain: () => {
      const now = current.current
      if (!now || now.phase !== 'done') return
      const again = manyReceipt(now.targets, now.results).again
      if (again.length > 0) start(now.command, again)
    },
    onClose: () => {
      // A run on its way finishes first: every order then says what happened to it.
      if (current.current?.phase === 'running') return
      turn.current += 1
      current.current = null
      setModel(null)
    },
    onStepUpSubmit: (code) => void stepUp.submitStepUp(code),
    onStepUpCancel: stepUp.cancelStepUp,
  }
  return { model: model ? { ...model, stepUp: stepUp.stepUp } : null, open, actions }
}
