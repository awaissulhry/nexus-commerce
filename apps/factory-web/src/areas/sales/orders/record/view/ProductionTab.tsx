'use client'

import { Card } from '@nexus/ui/components'
import { useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Order } from '../../api'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
// ---- F-SA-235: Specs in force (the tech pack in force, moved from the tab's foot) — W4 replaces it with "What we make it to" ----
import { TechPackCard } from '../../confirmation/view/ConfirmationCard'
// ---- end F-SA-235
// ---- F-PT-101 … F-PT-105 (order PRODUCTION tab, W1): the layout, Production now, Work orders (one file per section, view/production) ----
import { NowSection } from './production/NowSection'
import { WorkOrdersSection } from './production/WorkOrdersSection'
import { DatesSection } from './production/DatesSection' // F-PT-201 … 204: Dates, Milestones and Promise moves in one section
import { ProblemsSection } from './production/ProblemsSection' // F-PT-301 / 302: holds, what waits for an answer, quality
import { MaterialsSection } from './production/MaterialsSection' // F-PT-303: the customer's goods and what we buy, missing first
import './production/production.css'
// ---- end F-PT-101

/** The readiness words are the production lane's (`production-work-orders` readiness.*), reused in place. */
const WORK_ORDERS_NS = 'production-work-orders'

/**
 * F-PT-101 (order PRODUCTION tab, 10-design §1; 18-lead-settles L10) — the tab's LAYOUT: its root is a size container (production.css:
 * every section chooses by the room the tab has, never the screen — the thread dock opening or closing re-lays it at once), the six
 * sections top to bottom with their addresses: Production now (#now) · Work orders (#work-orders) · Dates & plan (#dates) · Problems &
 * holds (#holds) | What we make it to (#specs) — side by side from 900 px — · Materials (#materials). Each section is its own file
 * (view/production/*); the cards below that W3 – W4 replace stay here until then (one path per job: each goes when its section lands).
 * F-PT-201 … 204: Dates & plan (#dates, with #promise-moves) replaced the Dates card, the milestones' card and Promise moves;
 * F-PT-301 … 303: Problems & holds (#holds) and Materials (#materials) replaced Holds, quality & problems and the materials card.
 */
export function ProductionTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  return (
    <WithMessages namespaces={[WORK_ORDERS_NS, 'production' /* F-SA-235 · F-PT-102: the health's and the stages' words */]}>
      <div className="fw-pt">
        <NowSection order={order} model={model} actions={actions} />
        <WorkOrdersSection order={order} model={model} actions={actions} />
        <DatesSection order={order} model={model} actions={actions} />
        {/* F-SA-235: what holds it, its quality and its problems; the specs it is made to — F-PT-101 (L10): a pair by the tab's room. */}
        <div className="fw-pt-pairs">
          <ProblemsSection order={order} model={model} actions={actions} />
          <div id="specs" className="fw-so-anchor">
            <SpecsCard order={order} model={model} actions={actions} />
          </div>
        </div>
        <MaterialsSection order={order} model={model} actions={actions} />
      </div>
    </WithMessages>
  )
}

/**
 * P5 Specs in force: the revision of each style the order is made to (as the order fixes it; else the work order chooses), and the
 * customer's tech pack in force (the request's files: named vs newer, opened in the viewer). An open design change has its place
 * here once the change flow lands (S4).
 */
function SpecsCard({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const styles = [...new Map(order.lines.map((line) => [line.styleId, line])).values()]
  return (
    <div className="fw-so-stack">
      <Card padded>
        <h2 className="fw-so-h2">{t('production.specs.title')}</h2>
        <ul className="fw-so-datelist">
          {styles.map((line) => (
            <li key={line.styleId}>
              <span>{`${line.style?.code ?? '—'} · ${line.style?.name ?? ''}`}</span>
              <span className="fw-so-cell-sub">{line.styleRevision ? t('lines.revision', { revision: line.styleRevision.revision }) : t('lines.noRevision')}</span>
            </li>
          ))}
        </ul>
      </Card>
      <TechPackCard model={model.depth} actions={actions?.depth} />
    </div>
  )
}
// ---- end F-SA-235
