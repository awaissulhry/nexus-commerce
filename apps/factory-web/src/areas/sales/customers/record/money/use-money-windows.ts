'use client'

import { useCallback, useMemo, useState } from 'react'
import { useToast } from '@nexus/ui/components'
import { useT } from '../../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../../lib/session/context'
import { abilitiesOf } from '../../../orders/model'
import { useOrderMoneyDoor, type OrderMoneyDoorActions, type OrderMoneyDoorDone, type OrderMoneyDoorModel } from '../../../orders/record/money/door/use-order-money-door'
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
  return { door: { model: door.model, actions: door.actions }, stop, onAct, closeStop }
}
