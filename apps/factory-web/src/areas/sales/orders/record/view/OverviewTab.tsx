'use client'

import { Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { HealthPill } from '../../../../../lib/production/view/HealthPill'
import type { Order } from '../../api'
import { bandHealthOf, healthInputOf, readOf } from '../overview/model'
import { orderWaitingOf } from '../overview/model' // F-OP-301 (walk #1–#3): the ONE call of the waiting list
import type { OrderRecordActions, OrderRecordModel } from '../record-model'
// ---- F-OO-100 (order overview lane): one file per card; this file keeps the layout and the band's two parts ----
import { WhereCard } from './overview/WhereCard'
import { ProgressCard } from './overview/ProgressCard'
import { PeopleCard } from './overview/PeopleCard'
import { DatesCard } from './overview/DatesCard'
import { RequestsCard } from './overview/RequestsCard'
import { LinkedCard } from './overview/LinkedCard'
import { FactsCard } from './overview/FactsCard'
// ---- end F-OO-100

/**
 * F-SA-232 (sales page plan N2, picks P2, P3, P4, P15, R9; 10-order-page §2.1 O1, O2; review OW-6, OW-7) — Overview, the order page's
 * first tab: "Where it is now" (the plain stage and "1 line ahead" — or before / after production the commercial words —, who acts
 * next, the ex-factory date and how often it moved, the health, the customer's own urgency, the bundles in work as counts, the five
 * plain stages with the blocked mark, "Live · as of 10:42") and "Progress by line" (the order's OWN pieces per colour line, the
 * made-to-measure units of one style × colourway as one row; "Not counted here", never 0) whose row opens the line's sizes in a
 * centred window (‹ › walk the lines). The production lane's parts in place (StageStrip, HealthPill, WaitingOnPill, PiecesGrid,
 * FreshnessLine) and the one picture part. Office face only: no operator, no station, no other customer.
 * F-OO-100: each card is its own file in view/overview/ (its rules in overview/<section>.ts); this file draws them in order.
 */
export function OverviewTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const locale = useLocale()
  // F-OP-103: the ONE waiting list — Who acts next is its first row, the Requests & changes card its rows (the Changes badge, R-22).
  // F-OP-301 (walk #1–#3): through the ONE call the badge and the Changes tab make too; nothing claimed before the production read.
  const waiting = orderWaitingOf(order, model, locale)
  return (
    <div className="fw-so-overview">
      <WhereCard order={order} model={model} actions={actions} waiting={waiting} />
      <ProgressCard order={order} model={model} actions={actions} />
      {/* F-SA-233: the facts beside each other (a card grid that follows the body's width, never dead space). */}
      <div className="fw-so-overview-cards">
        <PeopleCard order={order} model={model} actions={actions} />
        <DatesCard order={order} model={model} actions={actions} />
        <RequestsCard order={order} model={model} actions={actions} waiting={waiting} />
        <LinkedCard order={order} model={model} />
        <FactsCard order={order} model={model} />
      </div>
    </div>
  )
}

/** The band's health chip from the production read (Late or At risk only), with its why; the order read's lateness until it comes. */
export function BandHealth({ order, model }: { order: Order; model: OrderRecordModel }) {
  const read = readOf(model.production)
  const input = healthInputOf(order, read?.headline ?? null, read?.dates ?? null)
  if (!bandHealthOf(input)) return null
  return <HealthPill face="office" {...input} />
}

/** "Urgent (customer)" in the band when the customer marked it (read only). */
export function BandUrgency({ model }: { model: OrderRecordModel }) {
  const t = useT('orders')
  const read = readOf(model.production)
  return read?.headline?.urgency.customer?.code === 'URGENT' ? <Tag tone="warning">{t('board.customerUrgent')}</Tag> : null
}
