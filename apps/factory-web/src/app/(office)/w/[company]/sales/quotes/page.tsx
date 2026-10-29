import { Suspense } from 'react'
import type { Metadata } from 'next'
import { QuotesPage } from '../../../../../../areas/sales/quotes/list/QuotesPage'

export const metadata: Metadata = { title: 'Quotes · Nexus Factory' }

/**
 * Sales › Quotes (SCR-034; areas/sales/nav.ts, permission quotes.view). The company layout above loaded the session and
 * draws the Office shell; the page is the client container (filters in the address: `?status=&mine=1&expiring=1&q=`,
 * `?new=1` opens New quote).
 */
export default function Page() {
  return (
    <Suspense>
      <QuotesPage />
    </Suspense>
  )
}
