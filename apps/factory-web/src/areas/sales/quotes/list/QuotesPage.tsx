'use client'

import { WithMessages } from '../../../../record-panels/i18n'
import { QuotesListView } from './view/QuotesListView'
// B-W2b-348: Quote speed under the list (design sales.quotes sec quotes.speed).
import { QuoteSpeed } from '../speed/QuoteSpeed'
// F-SA-277: the container's body moved to use-quotes-list.ts (the ONE Quotes list, for every host).
import { QUOTES_PATH, useQuotesList } from './use-quotes-list'

/**
 * `/w/<company>/sales/quotes` (SCR-034): the ONE Quotes list (use-quotes-list.ts, F-SA-277: its reads, its tiles, its address,
 * its live changes, New quote, Duplicate, Cancel N) on its own page — every term its own and in the address, its own band and
 * tiles, a row opens its quote — and Quote speed under it.
 */
export function QuotesPage() {
  return (
    <WithMessages namespaces={['sales']}>
      <QuotesContainer />
    </WithMessages>
  )
}

function QuotesContainer() {
  const { model, actions } = useQuotesList({ basePath: QUOTES_PATH })
  return (
    // B-W2b-348: the list, then Quote speed (SCR-428).
    <div className="fw-qsp-page">
      <QuotesListView model={model} actions={actions} />
      <QuoteSpeed />
    </div>
  )
}
