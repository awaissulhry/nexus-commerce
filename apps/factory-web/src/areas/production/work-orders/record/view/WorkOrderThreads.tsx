'use client'

import type { ReactNode } from 'react'
import { SegmentedControl } from '@nexus/ui/primitives'
import { useT } from '../../../../../lib/i18n/provider'
import type { OrderThreadChoice, ThreadPick } from '../order-files/model'

/**
 * B-TH-265 (agreement T9; PL1 "ONE thread per page"): the work order's dock holds ONE thread at a time — the work order's own notes
 * (never shareable with a customer; a note may go to the floor with its 'For the floor' tick) or, picked beside it, one of its orders'
 * threads (shared with that order's customer). The pick sits at the dock's top only when an order's thread may be read; under it one
 * line says whose the picked order thread is, so nobody writes to a customer believing it stays in the office. The dock's children
 * are the picked thread (the office's OfficeRecordThread docked, or a design case's).
 */
export function WorkOrderThreads({ choices, pick, onPick, children }: { choices: readonly OrderThreadChoice[]; pick: ThreadPick; onPick?: (pick: ThreadPick) => void; children: ReactNode }) {
  const t = useT('production')
  const picked = choices.find((choice) => choice.orderId === pick) ?? null
  return (
    <>
      {choices.length > 0 && (
        <div className="fw-pr-threadpick">
          <SegmentedControl
            size="sm"
            wrap
            ariaLabel={t('thread.pickLabel')}
            value={picked ? picked.orderId : 'workOrder'}
            onChange={(value) => onPick?.(value)}
            options={[{ value: 'workOrder', label: t('thread.workOrder'), title: t('thread.workOrderHint') }, ...choices.map((choice) => ({ value: choice.orderId, label: `${choice.number} · ${choice.party.name}` }))]}
          />
          <p className="fw-pr-hint">{picked ? t('thread.orderShared', { number: picked.number, customer: picked.party.name }) : t('thread.workOrderHint')}</p>
        </div>
      )}
      {children}
    </>
  )
}
