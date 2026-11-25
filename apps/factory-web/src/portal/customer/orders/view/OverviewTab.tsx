'use client'

import type { ReactNode } from 'react'
import { Overview, OverviewPair } from '../../../../lib/record-overview/Overview'
import type { OrderRecord } from '../api'
import { overviewOf, pairsOf } from '../overview/model'
import { useOrderWords } from '../words'
import type { OrderRecordActions, OrderRecordViewModel } from './OrderRecordView'
import { ProductionQualityCard } from './QualityCard'
import { DatesCard, FactsCard, PayCard, ProgressCard, RequestsCard } from './overview/Cards'
import { WhereCard } from './overview/WhereCard'

/**
 * pp-w2 (w2.2–w2.4; lane pp-, round 1; 10-design § 5) — Order › Overview: the office order's Overview drawn by the SAME kit
 * (lib/record-overview: `Overview`, `OverviewPair`, `OverviewCard` and its rows), in the office's reading order — Where your order is
 * → Progress by line → Next dates | Requests & changes → Quality and photos | What you pay → Order facts. Built from the page's own
 * reads only (overview/model.ts); a card without its right or share level is left out and the next card pairs up (pp-fx4, W-08). It replaces
 * Status & progress (StatusTab): the re-confirm, waiting and hold banners are strips of the lead card, "Made from" and the health chip
 * are the band's, "Order files" is the Files tab's, the old progress card's pieces are the same grid's.
 */
export function OverviewTab({ model, record, actions }: { model: OrderRecordViewModel; record: OrderRecord; actions?: OrderRecordActions }): ReactNode {
  const words = useOrderWords()
  const cards = overviewOf({ ...model, record, words })
  const production = model.production?.state === 'ready' ? model.production.read : null
  const quality =
    cards.quality && production && model.quality ? (
      <ProductionQualityCard key="quality" quality={{ state: model.quality.state === 'hidden' ? 'ready' : model.quality.state, read: model.quality.read }} refreshSeconds={production.progress?.refreshSeconds ?? null} offline={model.offlineSince !== null} fileHeld={model.fileHeld} actions={actions} />
    ) : null
  const dates = cards.dates ? <DatesCard key="dates" model={cards.dates} /> : null
  const requests = cards.requests ? <RequestsCard key="requests" model={cards.requests} items={model.requests.items} actions={actions} /> : null
  const pay = cards.pay ? <PayCard key="pay" model={cards.pay} /> : null
  return (
    // pp-fx4 (walk W-11): the Overview's text at the picture's 13 px (orders.css `.fw-pord-ov`), the kit's own classes untouched.
    <div className="fw-pord-ov">
      <Overview>
        <WhereCard model={cards.where} page={model.revision.page} actions={actions} />
        {cards.progress ? <ProgressCard model={cards.progress} onRetry={cards.progress.from === 'progress' ? actions?.onRetryProgress : actions?.onRetryProduction} /> : null}
        {/* pp-fx4 (walk W-08): the pairs are built from the cards that are present, in the picture's order (no lone card beside dead space). */}
        {pairsOf([dates, requests, quality, pay, <FactsCard key="facts" model={cards.facts} />]).map((pair, index) => (
          <OverviewPair key={index}>{pair}</OverviewPair>
        ))}
      </Overview>
    </div>
  )
}
