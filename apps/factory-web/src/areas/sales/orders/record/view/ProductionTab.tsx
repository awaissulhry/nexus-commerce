'use client'

import { WithMessages } from '../../../../../record-panels/i18n'
import type { Order } from '../../api'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
// ---- F-PT-101 … F-PT-105 (order PRODUCTION tab, W1): the layout, Production now, Work orders (one file per section, view/production) ----
import { NowSection } from './production/NowSection'
import { WorkOrdersSection } from './production/WorkOrdersSection'
import { DatesSection } from './production/DatesSection' // F-PT-201 … 204: Dates, Milestones and Promise moves in one section
import { ProblemsSection } from './production/ProblemsSection' // F-PT-301 / 302: holds, what waits for an answer, quality
import { MakeToSection } from './production/MakeToSection' // F-PT-401 / 402: our pattern and the customer's tech pack
import { MaterialsSection } from './production/MaterialsSection' // F-PT-303: the customer's goods and what we buy, missing first
import './production/production.css'
// ---- end F-PT-101

/** The readiness words are the production lane's (`production-work-orders` readiness.*), reused in place. */
const WORK_ORDERS_NS = 'production-work-orders'

/**
 * F-PT-101 (order PRODUCTION tab, 10-design §1; 18-lead-settles L10) — the tab's LAYOUT, and only that: its root is a size container
 * (production.css: every section chooses by the room the tab has, never the screen — the thread dock opening or closing re-lays it
 * at once), the six sections top to bottom with their addresses: Production now (#now) · Work orders (#work-orders) · Dates & plan
 * (#dates) · Problems & holds (#holds) | What we make it to (#specs) — side by side from 900 px — · Materials (#materials). Each
 * section is its own file (view/production/*). F-PT-403: the old cards are gone (one path per job).
 */
export function ProductionTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[WORK_ORDERS_NS, 'production' /* F-SA-235 · F-PT-102: the health's and the stages' words */]}>
      <div className="fw-pt">
        <NowSection order={order} model={model} actions={actions} />
        <WorkOrdersSection order={order} model={model} actions={actions} />
        <DatesSection order={order} model={model} actions={actions} />
        {/* F-PT-101 (L10): Problems & holds and What we make it to, a pair by the tab's room. */}
        <div className="fw-pt-pairs">
          <ProblemsSection order={order} model={model} actions={actions} />
          <MakeToSection order={order} model={model} actions={actions} />
        </div>
        <MaterialsSection order={order} model={model} actions={actions} />
      </div>
    </WithMessages>
  )
}
