import { Suspense } from 'react'
import type { Metadata } from 'next'
import { QuoteRecord } from '../../../../../../../areas/sales/quotes/record/QuoteRecord'

export const metadata: Metadata = { title: 'Quote · Nexus Factory' }

/** Sales › Quotes › a quote (SCR-035; `?tab=lines|price|terms|versions|approval|documents|activity`). */
export default async function Page({ params }: { params: Promise<{ quoteId: string }> }) {
  const { quoteId } = await params
  return (
    <Suspense>
      <QuoteRecord quoteId={decodeURIComponent(quoteId)} />
    </Suspense>
  )
}
