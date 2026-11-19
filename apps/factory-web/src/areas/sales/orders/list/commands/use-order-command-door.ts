'use client'

import { useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { approveTask, listRejectReasons, rejectTask } from '../../../../home/approvals/api'
import { cancelOrder, closeOrder, getCancelCheck, getOrder, markReady, type Order } from '../../api'
import { isStepUpCancelled, useStepUp } from '../../hooks'
import { readProblem, writeProblem, type OrderAbilities } from '../../model'
import type { OrderCommandActions, OrderCommandModel, WindowCommand } from './model'

/**
 * F-CP-108 (customer page plan C2b, D8, K2; 10-customer-page §3.1): the row ⋯ "Next steps" door of the Orders sheet — ONE window at a
 * time. Opening reads the order once (GET /sales/orders/:id: the server's wall — an order out of reach answers 404, said neutrally),
 * Cancel order… its impact check too (GET …/cancel-check); A14's rules run on the order as read (view/OrderCommandWindow) and the order
 * page's OWN dialogs draw it. Every write is the order page's route with the order's version as read and an Idempotency-Key (the calls'
 * own; the yes: one key for the yes and its repeat after the code): Mark ready (POST …/ready {version, reason}), Close (POST …/close
 * {version, reason?}), Cancel (POST …/cancel {version, reason, confirmNumber}), the yes (POST /approvals/tasks/:id/approve | reject, the
 * task's version; a fresh code first when its rule asks one). Done: the window closes and the host puts the order where its row stands
 * (rows never jump) with a toast. Refused: the order page's words inside the dialog, what was typed stays; a moved order is read again.
 */
export function useOrderCommandDoor(
  api: ApiClient,
  input: {
    readonly can: OrderAbilities
    readonly prefix: string
    /** A command went: the order as it answered (null: the yes — the host reads the row again), and what to say. */
    readonly onDone: (done: { readonly id: string; readonly number: string; readonly command: WindowCommand | 'refuse'; readonly order: Order | null }) => void
  },
): { model: OrderCommandModel | null; open: (row: { readonly id: string; readonly number: string }, command: WindowCommand) => void; actions: OrderCommandActions } {
  const [model, setModel] = useState<OrderCommandModel | null>(null)
  // The window as it is now (answers arrive later; one for an earlier window is dropped by its turn).
  const current = useRef<OrderCommandModel | null>(null)
  const turn = useRef(0)
  const stepUp = useStepUp(api)
  const onDone = useRef(input.onDone)
  onDone.current = input.onDone

  const update = (mine: number, change: (now: OrderCommandModel) => OrderCommandModel) => {
    const now = current.current
    if (!now || mine !== turn.current) return
    const next = change(now)
    current.current = next
    setModel(next)
  }

  const read = (mine: number, id: string, command: WindowCommand) => {
    update(mine, (now) => ({ ...now, problem: null }))
    getOrder(api, id)
      .then((order) => update(mine, (now) => ({ ...now, order, problem: null })))
      .catch((error: unknown) => update(mine, (now) => ({ ...now, order: null, problem: readProblem(error) })))
    if (command === 'cancel') readCheck(mine, id)
  }
  const readCheck = (mine: number, id: string) => {
    update(mine, (now) => ({ ...now, cancelCheck: { value: null, problem: null } }))
    getCancelCheck(api, id)
      .then((check) => update(mine, (now) => ({ ...now, cancelCheck: { value: check, problem: null } })))
      .catch((error: unknown) => update(mine, (now) => ({ ...now, cancelCheck: { value: null, problem: readProblem(error) } })))
  }

  const open = (row: { readonly id: string; readonly number: string }, command: WindowCommand) => {
    const mine = ++turn.current
    const next: OrderCommandModel = { command, target: { id: row.id, number: row.number }, order: null, problem: null, busy: false, dialogProblem: null, cancelCheck: null, refuse: null, refuseReasons: null, stepUp: stepUp.stepUp, can: input.can, prefix: input.prefix }
    current.current = next
    setModel(next)
    read(mine, row.id, command)
  }

  const close = () => {
    // A write on its way finishes first (its answer says what happened).
    if (current.current?.busy) return
    turn.current += 1
    current.current = null
    setModel(null)
  }

  /** The one write of the window: busy, the answer → done (the window closes); a refusal → its words in the dialog (typed kept). */
  const write = async (run: (order: Order) => Promise<Order | null>, command: WindowCommand | 'refuse') => {
    const now = current.current
    const mine = turn.current
    if (!now || !now.order || now.busy) return
    const order = now.order
    update(mine, (m) => ({ ...m, busy: true, dialogProblem: null }))
    try {
      const answered = await run(order)
      if (mine !== turn.current) return
      turn.current += 1
      current.current = null
      setModel(null)
      onDone.current({ id: order.id, number: order.number, command, order: answered })
    } catch (error) {
      if (isStepUpCancelled(error)) return update(mine, (m) => ({ ...m, busy: false }))
      const words = writeProblem(error)
      update(mine, (m) => ({ ...m, busy: false, dialogProblem: words }))
      // The order moved on (or is gone): read again — the dialog stays with what was typed while the order still allows it.
      if (words.reload) read(mine, order.id, now.command)
    }
  }

  const taskOf = (taskId: string) => (current.current?.order?.openApprovals ?? []).find((task) => task.taskId === taskId) ?? null

  const actions: OrderCommandActions = {
    onClose: close,
    onRetry: () => {
      const now = current.current
      if (now) read(turn.current, now.target.id, now.command)
    },
    onRetryCheck: () => {
      const now = current.current
      if (now) readCheck(turn.current, now.target.id)
    },
    onReady: (reason) => void write((order) => markReady(api, order.id, { version: order.version, reason }), 'ready'),
    onCloseOrder: (reason) => void write((order) => closeOrder(api, order.id, { version: order.version, ...(reason ? { reason } : {}) }), 'close'),
    onCancel: (reason, typed, extraOutcome) => void write(async (order) => (await cancelOrder(api, order.id, { version: order.version, reason, confirmNumber: typed, ...(extraOutcome ? { extraOutcome } : {}) })).order, 'cancel'),
    yes: {
      // F-OP-101's acts, as the order page's band runs them: the task's version; a fresh code first when the yes's rule asks one.
      onConfirm: (taskId) => {
        const task = taskOf(taskId)
        if (!task) return
        const key = newIdempotencyKey() // the yes and its repeat after the code: the engine answers the second from its receipt
        void write(async () => {
          if (task.requireStepUp) await stepUp.ensureFresh('approval.stepUp')
          await stepUp.guard('approval.stepUp', () => approveTask(api, { id: task.taskId, version: task.version }, null, key))
          return null
        }, 'confirm')
      },
      onRefuse: (taskId) => {
        const mine = turn.current
        if (!taskOf(taskId)) return
        update(mine, (m) => ({ ...m, refuse: { taskId }, refuseReasons: { value: null, problem: null }, dialogProblem: null }))
        listRejectReasons(api)
          .then((reasons) => update(mine, (m) => ({ ...m, refuseReasons: { value: reasons, problem: null } })))
          .catch((error: unknown) => update(mine, (m) => ({ ...m, refuseReasons: { value: null, problem: readProblem(error) } })))
      },
      onRefuseConfirm: (taskId, reasonCode, words) => {
        const task = taskOf(taskId)
        if (!task) return
        void write(async () => {
          await stepUp.guard('approval.stepUp', () => rejectTask(api, { id: task.taskId, version: task.version }, reasonCode, words))
          return null
        }, 'refuse')
      },
      onRefuseReasons: () => {
        const now = current.current
        if (now?.refuse) actions.yes?.onRefuse?.(now.refuse.taskId)
      },
    },
    onRefuseBack: () => update(turn.current, (m) => (m.busy ? m : { ...m, refuse: null, refuseReasons: null, dialogProblem: null })),
    onStepUpSubmit: (code) => void stepUp.submitStepUp(code),
    onStepUpCancel: stepUp.cancelStepUp,
  }

  // The code's dialog state is the step-up hook's own (it lives beside the window's).
  return { model: model ? { ...model, stepUp: stepUp.stepUp } : null, open, actions }
}
