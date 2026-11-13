'use client'

import type { ApiClient } from '../../../../../lib/api/client'
import type { QuoteDetail, QuoteLine } from '../../api'
import type { Grains } from '../../model'
import { useLineConfigurator } from './use-configurator'
import { ConfiguratorView } from './view/ConfiguratorView'

export interface QuoteLineOptionsProps {
  api: ApiClient
  quote: QuoteDetail
  line: QuoteLine
  grains: Grains
  onQuote: (next: QuoteDetail) => void
}

/**
 * The line drawer's "Options" section (B-W2b-340; B-W2b-316's open slot, order 20): the configurator of the quote line — its
 * style's options with their rules and surcharges, panel colours and leather, the customer's artwork, the price and margin
 * the API checks for the draft and the main picture of its colourway. A save answers the quote: the record follows it.
 */
export function QuoteLineOptions({ api, quote, line, grains, onQuote }: QuoteLineOptionsProps) {
  const { model, actions } = useLineConfigurator({ api, target: { kind: 'QUOTE', quoteId: quote.id, lineId: line.id }, grains, onQuote, refreshKey: String(quote.version) })
  return <ConfiguratorView model={model} actions={actions} />
}
