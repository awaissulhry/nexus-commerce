import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PriceListsPage } from '../../../../../../areas/sales/pricelists/list/PriceListsPage'

export const metadata: Metadata = { title: 'Price lists · Nexus Factory' }

/**
 * Sales › Pricing › Price lists & contracts (SCR-106; areas/sales/nav.ts, permission pricelists.view). The company layout
 * above loaded the session and draws the Office shell; the page is the client container (filters in the address:
 * `?rows=&soon=&kind=&q=`, `?new=1` opens New price list).
 */
export default function Page() {
  return (
    <Suspense>
      <PriceListsPage />
    </Suspense>
  )
}
