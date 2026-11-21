'use client'

import type { Order } from '../../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { WaitingSection } from './WaitingSection'
import { FreezeSection } from './FreezeSection'
import { HistorySection } from './HistorySection'
import { AgreementSection } from './AgreementSection'

/**
 * F-OC-101 (order CHANGES tab, 10-design §1; 18-lead-settles L6) — the tab's LAYOUT, and only that. Its root is the Production kit's
 * size container (`fw-pt`, production.css, which the kit imports: every section chooses by the room the tab has, never the screen,
 * so the thread dock opening or closing re-lays it at once). Four sections, top to bottom (changes/layout.ts CHANGES_SECTIONS):
 * Waiting (#waiting) · Can it still change?
 * (#freeze) · What changed (#history) · Customer's agreement (#confirmation). Each section is its own file (changes/view/*).
 */
export function ChangesTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <div className="fw-pt fw-oc">
      <WaitingSection order={order} model={model} actions={actions} />
      <FreezeSection order={order} model={model} actions={actions} />
      <HistorySection order={order} model={model} actions={actions} />
      <AgreementSection order={order} model={model} actions={actions} />
    </div>
  )
}
