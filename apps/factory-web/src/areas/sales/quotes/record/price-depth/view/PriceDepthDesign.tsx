'use client'

import { useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import type { QuoteRecordViewModel } from '../../record-model'
import { QuoteRecordView } from '../../view/QuoteRecordView'
import { DEPTH_NS } from '../../lines-depth/model'
import { depthSlots, type QuoteDepthModel } from '../../lines-depth/view/DepthSlots'
import type { PricingLine } from '../api'
import { PRICE_DEPTH_NS } from '../model'
import { BlockPrices } from './BlockPrices'
import { LineWaterfallView, type LineWaterfallModel } from './LineWaterfallView'
import { PricingByLine, type PricingByLineModel } from './PricingByLine'

export interface PriceDepthDesignModel {
  record: QuoteRecordViewModel
  /** Price & margin › Pricing by line. */
  pricing?: PricingByLineModel
  /** The line drawer (B-W2b-316's) with this step's section in it. */
  drawer?: QuoteDepthModel['drawer']
  waterfall?: LineWaterfallModel
  /** Lines: the block's discount and price by size from this pricing. */
  blockPricing?: readonly PricingLine[]
}

const EMPTY: QuoteDepthModel = { notice: null, linesTop: null, table: null, composer: { inquiry: null }, canFill: false, goal: null, terms: null, versions: null, deposit: null, drawer: null, bulk: null, paste: null, compare: null }

/** The quote record with this step's parts drawn from one model (the design index's SCR-035-prices; the live page uses use-price-depth). */
export function PriceDepthDesign({ model }: { model: PriceDepthDesignModel }) {
  return (
    <WithMessages namespaces={['sales', 'records', DEPTH_NS, PRICE_DEPTH_NS]}>
      <Record model={model} />
    </WithMessages>
  )
}

function Record({ model }: { model: PriceDepthDesignModel }) {
  const t = useT(DEPTH_NS)
  const words = useT(PRICE_DEPTH_NS)
  const quote = model.record.quote.status === 'ready' ? model.record.quote.value : null
  const drawer = model.drawer && model.waterfall ? { ...model.drawer, sections: [{ id: 'waterfall', order: 10, title: words('drawer.title'), body: <LineWaterfallView model={model.waterfall} /> }] } : null
  const slots = depthSlots({ ...EMPTY, drawer }, undefined, t)
  return (
    <QuoteRecordView
      model={model.record}
      depth={{
        ...slots,
        pricing: model.pricing ? <PricingByLine model={model.pricing} /> : undefined,
        blockPrices: model.blockPricing && quote ? (block) => <BlockPrices model={{ lines: block.lines, currency: quote.current.currency, pricing: model.blockPricing ?? null }} /> : undefined,
      }}
    />
  )
}
