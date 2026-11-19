'use client'

import type { ReactNode } from 'react'
import { Lock, ShoppingBag } from 'lucide-react' // F-OP-203: the segments' icons
import { useT } from '../../../../../lib/i18n/provider'
import type { OrderThreadChoice, ThreadPick as OrderFilesPick } from '../order-files/model'
// F-SA-260: THE pick of a record's dock, lifted from here (the order page and the customer page use it too).
import { ThreadPick, type ThreadChoice } from '../../../../_shared/record-thread/ThreadPick'

/**
 * B-TH-265 (agreement T9; PL1 "ONE thread per page"): the work order's dock holds ONE thread at a time — the work order's own notes
 * (never shareable with a customer; a note may go to the floor with its 'For the floor' tick) or, picked beside it, one of its orders'
 * threads (shared with that order's customer). The pick sits at the dock's top only when an order's thread may be read; under it one
 * line says whose the picked order thread is, so nobody writes to a customer believing it stays in the office. The dock's children
 * are the picked thread (the office's OfficeRecordThread docked, or a design case's).
 *
 * F-SA-260: drawn by the shared ThreadPick (areas/_shared/record-thread) with the work order's own words — the same choices, the same
 * value (an order not among them shows the work order's notes), the same line, the same look.
 *
 * F-OP-203 (order page plan N4; 11-dock §0.1, §2): the pick is the first band inside the dock's one card (ThreadPick hands it to the
 * docked thread); the work order's notes with the Lock and their line in the office tone, each order with its bag. No new props.
 */
export function WorkOrderThreads({ choices, pick, onPick, children }: { choices: readonly OrderThreadChoice[]; pick: OrderFilesPick; onPick?: (pick: OrderFilesPick) => void; children: ReactNode }) {
  const t = useT('production')
  const threads: ThreadChoice[] = [
    { value: 'workOrder', label: t('thread.workOrder'), title: t('thread.workOrderHint'), icon: <Lock size={14} aria-hidden />, tone: 'office', line: t('thread.workOrderHint') },
    ...choices.map((choice) => ({ value: choice.orderId, label: `${choice.number} · ${choice.party.name}`, icon: <ShoppingBag size={14} aria-hidden />, line: t('thread.orderShared', { number: choice.number, customer: choice.party.name }) })),
  ]
  return (
    <ThreadPick label={t('thread.pickLabel')} choices={threads} value={pick} onPick={onPick}>
      {children}
    </ThreadPick>
  )
}
