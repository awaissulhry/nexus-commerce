'use client'

import type { Order } from '../../../api'
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { InvoicesSection } from './InvoicesSection'
import { MarginSection } from './MarginSection' // F-SA-230 → F-OM-302: Margin is Money's last section, in the kit
import { MoneyHead } from './MoneyHead'
import { PaymentsSection } from './PaymentsSection'
import { PriceCheckSection } from './PriceCheckSection' // F-CP-142 → F-OM-301: moved here, in the kit
import { TotalsSection } from './TotalsSection'
import './money.css'

/**
 * F-OM-101 (order MONEY tab, 10-design §1; 18-lead-settles L6) — the tab's LAYOUT, and only that (moved from view/MoneyTab.tsx). Its
 * root is the Production kit's size container (`fw-pt`, production.css, which the kit imports: every section chooses by the room the
 * tab has, never the screen, so the thread dock opening or closing re-lays it at once). Under the tab's one answer line (MoneyHead:
 * the money wall said ONCE), five sections that STACK at every width (money/layout.ts MONEY_SECTIONS): Totals (#totals) · Payments
 * (#payments; #deposit and #schedule land there) · Invoices & credit notes (#invoices, invoices.view) · Price check (#price-check,
 * the price grain) · Margin (#margin, the margin grain). Each section is its own file (money/view/*); the hand windows are mounted
 * once by the page (MoneyDialogs, OrderRecordView).
 */
export function MoneyTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <div className="fw-pt fw-om">
      <MoneyHead order={order} model={model} />
      <TotalsSection order={order} model={model} actions={actions} />
      <PaymentsSection order={order} model={model} actions={actions} />
      <InvoicesSection order={order} model={model} actions={actions} />
      {/* F-CP-142 → F-OM-301: hidden without the price grain — the tab's head says the money wall once: */ model.can.price && <PriceCheckSection order={order} model={model} actions={actions} />}
      {/* F-SA-230 → F-OM-302: hidden without the margin grain: */ model.can.margin && <MarginSection order={order} model={model} actions={actions} />}
    </div>
  )
}
