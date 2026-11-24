'use client'

import { useRef, useState } from 'react'
import type { ApiClient } from '../../../../../../lib/api/client'
import { getOrder, getSchedule, getSettlement, type Order, type Schedule, type Settlement } from '../../../api'
import { isStepUpCancelled, useStepUp, type StepUpState } from '../../../hooks'
import { readProblem, romeToday, writeProblem, type OrderAbilities, type Phrase } from '../../../model'
import type { OrderRecordModel, Part, RecordDialog, RecordWrite } from '../../record-model'
import { stepAbilitiesOf } from '../../schedule/model'
import { useMoneyActs } from '../../use-money-acts'
import type { MoneyDialogActions, MoneyDialogModel } from '../../view/Dialogs'
import { useSay } from '../view/say'
import { doorRulingOf, type DoorActId, type DoorAsk, type DoorRuling } from './model'

/** The door's window as it stands: what is asked, the order and its plan as read, the plan's rule on them, the order's windows. */
export interface OrderMoneyDoorModel {
  readonly target: { readonly id: string; readonly number: string }
  readonly ask: DoorAsk
  /** The order as read; null while it reads, or when the read failed (`problem`). */
  readonly order: Order | null
  /** The order's read failed: its words (`orders` problem.read.*; an order out of the reader's reach answers 404, said neutrally). */
  readonly problem: string | null
  /** The payment plan's read (value null while it reads). */
  readonly schedule: Part<Schedule> | null
  /** The settlement's read (invoices.view); null without the right. */
  readonly settlement: Part<Settlement> | null
  /** The plan's rule on the order as FIRST read (model.ts doorRulingOf); null while it reads. A read after a write never rules again. */
  readonly ruling: DoorRuling | null
  /** What the order page's money windows read (a Pick of the record's model: rec/view/Dialogs.tsx MoneyDialogModel). */
  readonly dialogs: MoneyDialogModel
  /** The fresh authenticator code's dialog (the order page's own state: useStepUp). */
  readonly stepUp: StepUpState
}

export interface OrderMoneyDoorActions {
  readonly onClose: () => void
  /** A failed read: read the order and its plan again. */
  readonly onRetry: () => void
  /** The order page's money windows' acts — the record's own (useMoneyActs); a window's Cancel or Done closes the door. */
  readonly dialogs: MoneyDialogActions
  readonly onStepUpSubmit: (code: string) => void
  readonly onStepUpCancel: () => void
}

/** An act went: its order and act, and the order page's own words for it when it has some (else the host says its own). */
export interface OrderMoneyDoorDone {
  readonly id: string
  readonly number: string
  readonly act: DoorActId
  readonly words: Phrase | null
}

type DoorWindow = Omit<OrderMoneyDoorModel, 'dialogs' | 'stepUp'> & { readonly today: string }

/**
 * F-CM-k2 (customer MONEY tab, 13-backend §4.1; 15-steps K2.3; the pattern of ord/list/commands/use-order-command-door.ts) — the money
 * DOOR: a To-collect row of the customer's Money tab runs the ORDER's own acts in the ORDER's own windows, ONE window at a time.
 * Nothing is read before `open()`. Opening reads the order (GET /sales/orders/:id: the server's wall — an order out of reach answers
 * 404), its payment plan and, with invoices.view, its settlement; then the plan's own rule on the order AS READ (model.ts doorRulingOf)
 * holds the act in its words, or opens the order page's window on the request (Record a payment…, Send the page…, the plan's hand
 * windows, Waive…). Every write is the order page's own: `useMoneyActs` UNCHANGED (with no order: the From-DDTs lookup does not run)
 * through this door's one write — the order's version as read, its Idempotency-Key, a fresh code where the order page asks one
 * (useStepUp). Done: the window closes and `onDone` tells the host (its burst and its toast). Refused: the order page's words inside
 * the window, what was typed stays; an order that moved on is read again.
 */
export function useOrderMoneyDoor(
  api: ApiClient,
  input: {
    /** The reader's abilities, by the order page's own rule (abilitiesOf). */
    readonly can: OrderAbilities
    readonly permissions: readonly string[]
    readonly prefix: string
    /** The signed-in person's name, for the hand windows' who line ("Saved as …"). */
    readonly me?: string | null
    readonly onDone: (done: OrderMoneyDoorDone) => void
  },
): { model: OrderMoneyDoorModel | null; open: (row: { readonly id: string; readonly number: string }, ask: DoorAsk) => void; actions: OrderMoneyDoorActions } {
  const [win, setWin] = useState<DoorWindow | null>(null)
  // The window as it is now (answers arrive later; one for an earlier window is dropped by its turn).
  const now = useRef<DoorWindow | null>(null)
  const turn = useRef(0)
  // The order as last read: the order page's acts read it when they run (RecordActsBase.current).
  const current = useRef<Order | null>(null)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const busyNow = useRef(false)
  const [dialogProblem, setDialogProblem] = useState<Phrase | null>(null)
  // A write that keeps its window (the page sent, the payment recorded: the window says what followed); its Done closes the door.
  const wrote = useRef<{ readonly words: Phrase | null } | null>(null)
  const { stepUp, guard, ensureFresh, submitStepUp, cancelStepUp } = useStepUp(api)
  const say = useSay(win?.order?.currency ?? 'EUR')
  const sayNow = useRef(say)
  sayNow.current = say
  const onDone = useRef(input.onDone)
  onDone.current = input.onDone
  const acts = useRef<ReturnType<typeof useMoneyActs> | null>(null)

  const update = (mine: number, change: (was: DoorWindow) => DoorWindow) => {
    const was = now.current
    if (!was || mine !== turn.current) return
    const next = change(was)
    now.current = next
    setWin(next)
  }

  /** The plan's rule on the order as first read — once; then the window it opens. */
  const settle = (mine: number) => {
    const was = now.current
    if (!was || mine !== turn.current || was.ruling || !was.order || !was.schedule?.value) return
    // The settlement (invoices.view) is part of the plan as read: its answer is waited for (a failed one counts as none, as on the order page).
    if (was.settlement && !was.settlement.value && !was.settlement.problem) return
    const ruling = doorRulingOf({ ask: was.ask, order: was.order, schedule: was.schedule.value, settlement: was.settlement?.value ?? null, can: input.can, stepCan: stepAbilitiesOf(input.permissions), today: was.today })
    update(mine, (m) => ({ ...m, ruling }))
    const start = ruling.start
    if (!start) return
    if (start.kind === 'dialog') {
      setDialog(start.dialog)
      // The order page's own opening: it reads what the window lists (the customer's contacts for Send the page…).
      acts.current?.opened(start.dialog)
    } else acts.current?.actions.scheduleSteps?.onWaive?.({ target: start.target, label: sayNow.current(start.title), stepKind: start.stepKind })
  }

  const readParts = (mine: number, order: Order) => {
    update(mine, (m) => ({ ...m, schedule: m.schedule?.value ? m.schedule : { value: null, problem: null }, settlement: input.can.viewInvoices ? (m.settlement?.value ? m.settlement : { value: null, problem: null }) : null }))
    getSchedule(api, order.id)
      .then((value) => {
        update(mine, (m) => ({ ...m, schedule: { value, problem: null } }))
        settle(mine)
      })
      .catch((error: unknown) => update(mine, (m) => ({ ...m, schedule: { value: m.schedule?.value ?? null, problem: readProblem(error) } })))
    if (input.can.viewInvoices) {
      getSettlement(api, order.id)
        .then((value) => {
          update(mine, (m) => ({ ...m, settlement: { value, problem: null } }))
          settle(mine)
        })
        .catch((error: unknown) => {
          update(mine, (m) => ({ ...m, settlement: { value: m.settlement?.value ?? null, problem: readProblem(error) } }))
          settle(mine)
        })
    }
  }

  const read = (mine: number, id: string): Promise<void> => {
    update(mine, (m) => ({ ...m, problem: null }))
    return getOrder(api, id)
      .then((order) => {
        if (mine !== turn.current) return
        current.current = order
        update(mine, (m) => ({ ...m, order, problem: null }))
        readParts(mine, order)
      })
      .catch((error: unknown) => update(mine, (m) => ({ ...m, problem: readProblem(error) })))
  }

  const shut = () => {
    turn.current += 1
    now.current = null
    current.current = null
    wrote.current = null
    setWin(null)
    setDialog(null)
    setDialogProblem(null)
    // The window's answers are not said again by the next one (the page sent, the payment recorded, a preview, a refusal).
    acts.current?.opened(null)
    acts.current?.actions.scheduleSteps?.onWaive?.(null)
  }

  /** An act went: the window closes and the host is told. */
  const finish = (words: Phrase | null) => {
    const was = now.current
    if (!was) return
    shut()
    onDone.current({ id: was.target.id, number: was.order?.number ?? was.target.number, act: was.ask.act, words })
  }

  const close = () => {
    // A write on its way finishes first (its answer says what happened).
    if (busyNow.current) return
    // The window said what followed its write (Done): the act went.
    if (wrote.current) return finish(wrote.current.words)
    shut()
  }

  const open = (row: { readonly id: string; readonly number: string }, ask: DoorAsk) => {
    if (busyNow.current) return
    shut()
    const mine = turn.current
    const next: DoorWindow = { target: { id: row.id, number: row.number }, ask, order: null, problem: null, schedule: null, settlement: null, ruling: null, today: romeToday() }
    now.current = next
    setWin(next)
    void read(mine, row.id)
  }

  /** The door's ONE write — the order page's own rule (OrderRecord.tsx): busy, the answer read again, a refusal said in the window. */
  const write: RecordWrite = async (run, success, keepDialog = false) => {
    const was = now.current
    if (!was || busyNow.current) return
    const mine = turn.current
    busyNow.current = true
    setBusy(true)
    setDialogProblem(null)
    try {
      const answered = await run()
      if (mine !== turn.current) return
      if (answered) {
        current.current = answered
        update(mine, (m) => ({ ...m, order: answered }))
        readParts(mine, answered)
      } else await read(mine, was.target.id)
      const words = success ? { key: success } : null
      if (keepDialog) wrote.current = { words }
      else {
        busyNow.current = false
        finish(words)
      }
    } catch (error) {
      if (isStepUpCancelled(error) || mine !== turn.current) return
      const words = writeProblem(error)
      setDialogProblem(words)
      // The order moved on (or is gone): read again — the window stays with what was typed.
      if (words.reload) void read(mine, was.target.id)
    } finally {
      busyNow.current = false
      setBusy(false)
    }
  }

  /** The order page's notices: the schedule's Waive… says it went (success: the window closes); a refusal is said in the window. */
  const setNotice = (notice: OrderRecordModel['notice']) => {
    if (!notice) return
    if (notice.tone === 'success') return finish(notice.words)
    setDialogProblem(notice.words)
  }

  // ---- the order page's own acts, unchanged (F-OP-134's hook): with no order, the From-DDTs lookup does not run ----
  const money = useMoneyActs({
    api,
    orderId: win?.target.id ?? '',
    current,
    write,
    version: () => current.current?.version ?? 1,
    setNotice,
    load: () => (now.current ? read(turn.current, now.current.target.id) : Promise.resolve()),
    loadParts: (order) => readParts(turn.current, order),
    permissions: input.permissions,
    sdi: null,
    setSdi: () => undefined,
    stepUp: { ensureFresh, guard },
    // "Invoice this step" is never offered from a row (model.ts DOOR_ACTS).
    onInvoiced: () => undefined,
    order: null,
    prefix: input.prefix,
    me: input.me ?? null,
  })
  acts.current = money
  const inner = money.actions

  const model: OrderMoneyDoorModel | null = win
    ? {
        target: win.target,
        ask: win.ask,
        order: win.order,
        problem: win.problem,
        schedule: win.schedule,
        settlement: win.settlement,
        ruling: win.ruling,
        dialogs: { busy, can: input.can, dialog, dialogProblem, today: win.today, schedule: win.schedule, scheduleSteps: money.model.scheduleSteps, settlement: win.settlement, moneyPlan: money.model.moneyPlan, sentLink: money.model.sentLink, recorded: money.model.recorded },
        stepUp,
      }
    : null
  const actions: OrderMoneyDoorActions = {
    onClose: close,
    onRetry: () => {
      const was = now.current
      if (was) void read(turn.current, was.target.id)
    },
    dialogs: {
      ...inner,
      // A window's Cancel or Done closes the door (from here a window never opens another one).
      onDialog: (next) => {
        if (!next) close()
      },
      scheduleSteps: { ...inner.scheduleSteps, onWaive: (next) => (next ? inner.scheduleSteps?.onWaive?.(next) : close()) },
    },
    onStepUpSubmit: (code) => void submitStepUp(code),
    onStepUpCancel: cancelStepUp,
  }
  return { model, open, actions }
}
