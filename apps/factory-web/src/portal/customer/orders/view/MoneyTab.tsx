'use client'

import type { ReactNode } from 'react'
import { Overview } from '../../../../lib/record-overview/Overview'
import type { OrderRecord } from '../api'
import { overviewOf } from '../overview/model'
import { useOrderWords } from '../words'
import type { OrderRecordActions, OrderRecordViewModel } from './OrderRecordView'
import { PayCard } from './overview/Cards'
import { PriceCheckCard, PriceCheckDialog } from './PriceCheck'

/**
 * owb-po5.2 (settle 2; plan § 5i portal row, § 5m "Money (price holders)") — Order › Money, for a person who sees prices only (the
 * customer's Designer has no tab: the page never draws it for them). Round 1 of the tab: what the order costs and what is paid
 * ("What you pay", the Overview's card) and the customer's own Price check (moved here from Lines: the design's place). owb-po6.2 grows
 * it with the money read (totals, the payment plan, invoices, "I paid: tell the factory…").
 */
export function MoneyTab({ model, record, actions }: { model: OrderRecordViewModel; record: OrderRecord; actions?: OrderRecordActions }): ReactNode {
  const words = useOrderWords()
  if (!record.seesPrices) return null
  const cards = overviewOf({ ...model, record, words })
  // The overview kit loads its own words for its cards (their models carry ours): the price check (our words) sits beside it.
  return (
    <div className="fw-pord-tab">
      {cards.pay ? (
        <Overview>
          <PayCard model={cards.pay} />
        </Overview>
      ) : null}
      {model.priceCheck ? <PriceCheckCard model={model.priceCheck} actions={actions?.priceCheck} /> : null}
      {model.priceCheck?.dialog && model.priceCheck.check ? <PriceCheckDialog model={model.priceCheck.dialog} check={model.priceCheck.check} actions={actions?.priceCheck?.dialog} /> : null}
    </div>
  )
}
