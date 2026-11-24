'use client'

import { useCallback, useMemo, useState } from 'react'
import { useToast } from '@nexus/ui/components'
import { useT } from '../../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { abilitiesOf } from '../../../orders/model'
import { useOrderMoneyDoor, type OrderMoneyDoorActions, type OrderMoneyDoorDone, type OrderMoneyDoorModel } from '../../../orders/record/money/door/use-order-money-door'
// ---- F-CM-203: Finance's refund windows (RefundDialogs), driven here with Finance's own commands and rules ----
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { cancelRefund, payRefund, recordRefund, voidRefund, type Refund } from '../../../../finance/payments/refunds/api'
import { refundAbilitiesOf, refundAskOf, type RefundAbilities, type RefundDraft, type RefundMove, type RefundTarget } from '../../../../finance/payments/refunds/model'
import { writeProblem, type Phrase } from '../../../../finance/_shared/model'
import type { CollectInPlace, CollectRow } from './collect'
import { CM } from './model'

/**
 * F-CM-201 (customer page › MONEY tab, cm-w2 W2.1; 13-backend §4; 10-design §6) — the small drivers of the windows the tab opens IN
 * PLACE, never copied:
 *
 *   the money door   a To-collect request row's act opens the ORDER's own window (cm-k2: useOrderMoneyDoor reads the order, its plan
 *                    and its settlement only when asked, rules on the order AS READ, writes through the order page's own acts)
 *   the stop         "Promise to pay / dispute…" on an invoice row opens Finance's own stop container (ReminderDepth) in ONE centred
 *                    window (StopWindow.tsx)
 *
 * Done → the tab's burst (every money read again) and one toast: the order page's own words when it has some, else ours.
 */
export interface StopAsk {
  readonly invoice: { readonly id: string; readonly number: string | null; readonly dueDate: string | null }
}

export interface MoneyWindows {
  readonly door: { readonly model: OrderMoneyDoorModel | null; readonly actions: OrderMoneyDoorActions }
  readonly stop: StopAsk | null
  readonly onAct: (act: CollectInPlace, row: CollectRow) => void
  readonly closeStop: () => void
  /** F-CM-203: Finance's refund windows — Refund… (a credit note, a payment's money on account, or chosen in it), Mark made… · Cancel… · Void…. */
  readonly refunds: RefundWindows
}

export interface RefundWindows {
  readonly can: RefundAbilities
  /** Refund… open, on its start (a credit note's or a payment's id; null: chosen in it). */
  readonly dialog: { readonly start: string | null } | null
  /** A refund's move open. */
  readonly move: { readonly refund: Refund; readonly move: RefundMove } | null
  readonly busy: boolean
  readonly problem: Phrase | null
  readonly onOpen: (start: string | null) => void
  readonly onMove: (refund: Refund, move: RefundMove) => void
  readonly onRecord: (target: RefundTarget, draft: RefundDraft) => void
  readonly onDoMove: (input: { readonly paidOn: string; readonly reference: string; readonly reason: string }) => void
  readonly onClose: () => void
}

export function useMoneyWindows(input: { readonly prefix: string; readonly onBurst: () => void }): MoneyWindows {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const o = useT('orders')
  const t = useT(CM)
  const { toast } = useToast()
  const can = useMemo(() => abilitiesOf(session.permissions), [session.permissions])
  const { onBurst } = input
  const onDone = useCallback(
    (done: OrderMoneyDoorDone) => {
      toast(done.words ? o(done.words.key, done.words.params) : t(done.act === 'record' ? 'cm.done.record' : done.act === 'send' ? 'cm.done.send' : 'cm.done.saved', { number: done.number }), 'success')
      onBurst()
    },
    [o, t, toast, onBurst],
  )
  const door = useOrderMoneyDoor(api, { can, permissions: session.permissions, prefix: input.prefix, me: session.user.displayName, onDone })
  const [stop, setStop] = useState<StopAsk | null>(null)
  const { open } = door
  const onAct = useCallback(
    (act: CollectInPlace, row: CollectRow) => {
      if (act === 'stop') {
        if (row.target === 'INVOICE') setStop({ invoice: { id: row.id, number: row.invoice?.number ?? null, dueDate: row.due } })
        return
      }
      if (row.target === 'DEPOSIT_REQUEST' && row.order) open({ id: row.order.id, number: row.order.number }, { act, requestId: row.id })
    },
    [open],
  )
  const closeStop = useCallback(() => setStop(null), [])

  // ---- F-CM-203: the refund windows — Finance's own commands (refunds/api.ts), its own rules (refunds/model.ts), its own words ----
  const refundCan = useMemo(() => refundAbilitiesOf(session.permissions), [session.permissions])
  const [dialog, setDialog] = useState<{ readonly start: string | null } | null>(null)
  const [move, setMove] = useState<{ readonly refund: Refund; readonly move: RefundMove } | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const write = async (run: () => Promise<Refund>, done: 'cm.done.refund' | 'cm.done.refundMoved') => {
    if (busy) return
    setBusy(true)
    setProblem(null)
    try {
      await run()
      setDialog(null)
      setMove(null)
      toast(t(done), 'success')
      onBurst()
    } catch (error) {
      setProblem(writeProblem(error))
    } finally {
      setBusy(false)
    }
  }
  const refunds: RefundWindows = {
    can: refundCan,
    dialog,
    move,
    busy,
    problem,
    onOpen: (start) => {
      setProblem(null)
      setDialog({ start })
    },
    onMove: (refund, next) => {
      setProblem(null)
      setMove({ refund, move: next })
    },
    onRecord: (target, draft) => {
      const key = newIdempotencyKey()
      void write(() => recordRefund(api, refundAskOf(target, draft), key), 'cm.done.refund')
    },
    onDoMove: (input) => {
      const current = move
      if (!current) return
      const key = newIdempotencyKey()
      const run = current.move === 'paid' ? () => payRefund(api, current.refund, { paidOn: input.paidOn, externalRef: input.reference }, key) : current.move === 'cancel' ? () => cancelRefund(api, current.refund, input.reason, key) : () => voidRefund(api, current.refund, input.reason, key)
      void write(run, 'cm.done.refundMoved')
    },
    onClose: () => {
      setDialog(null)
      setMove(null)
      setProblem(null)
    },
  }
  return { door: { model: door.model, actions: door.actions }, stop, onAct, closeStop, refunds }
}
