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
import './overview/overview.css' // F-OO-201: the pairs and the shared card row

/**
 * F-SA-232 (sales page plan N2, picks P2, P3, P4, P15, R9; 10-order-page §2.1 O1, O2; review OW-6, OW-7) — Overview, the order page's
 * first tab: "Where it is now" (the plain stage and "1 line ahead" — or before / after production the commercial words —, who acts
 * next, the ex-factory date and how often it moved, the health, the customer's own urgency, the bundles in work as counts, the five
 * plain stages with the blocked mark, "Live · as of 10:42") and "Progress by line" (the order's OWN pieces per colour line, the
 * made-to-measure units of one style × colourway as one row; "Not counted here", never 0) whose row opens the line's sizes in a
 * centred window (‹ › walk the lines). The production lane's parts in place (StageStrip, HealthPill, WaitingOnPill, PiecesGrid,
 * FreshnessLine) and the one picture part. Office face only: no operator, no station, no other customer.
 * F-OO-100: each card is its own file in view/overview/ (its rules in overview/<section>.ts); this file draws them in order.
 * F-OO-103: "Where it is now" is now the headline (status · stage), its strips, the stages and the order's moves — what it showed
 * before (who acts next, the ex-factory date, the health, Urgent, the bundles) lives in one other place each (WhereCard.tsx says where).
 */
export function OverviewTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const locale = useLocale()
  // F-OP-103: the ONE waiting list — the Requests & changes card its rows (the Changes badge, R-22). F-OO-202: each row has its place:
  // Where it is now reads `waiting.holds`, Next dates `waiting.dates`, Requests & changes `waiting.card` (no "who acts next", F14).
  // F-OP-301 (walk #1–#3): through the ONE call the badge and the Changes tab make too; nothing claimed before the production read.
  const waiting = orderWaitingOf(order, model, locale)
  return (
    <div className="fw-so-overview">
      <WhereCard order={order} model={model} actions={actions} waiting={waiting} />
      <ProgressCard order={order} model={model} actions={actions} />
      {/* F-OO-201 (F4): then the cards in pairs, each pair its own row — 2 equal columns while the Overview is 720 px or wider, 1
          below; a card alone takes the whole row; the two cards of a pair stretch to one height (overview.css). */}
      <div className="fw-so-ov-pair">
        <PeopleCard order={order} model={model} actions={actions} />
        <DatesCard order={order} model={model} actions={actions} waiting={waiting /* F-OO-143: its DATE rows */} />
      </div>
      <div className="fw-so-ov-pair">
        <RequestsCard order={order} model={model} actions={actions} waiting={waiting} />
        <LinkedCard order={order} model={model} actions={actions /* F-OO-207: its doors (Make work orders…, Create shipment…) */} />
      </div>
      {/* Order facts, with Custom fields as the pair's second card (F-OO-211); alone, Order facts takes the row. */}
      <div className="fw-so-ov-pair">
        <FactsCard order={order} model={model} actions={actions /* F-OO-209: its doors */} />
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
