'use client'

import { useSearchParams } from 'next/navigation'
import { NewOrderPage } from '../new/NewOrderPage'
import { OfficeDraftPage } from './OfficeDraftPage'

/**
 * `/w/<co>/sales/orders/new` (od-w2.1): `?party=` — today's typed catalogue order (unchanged, the fast lane: 6a); otherwise the ONE draft
 * order — `?draft=<id>` the draft, nothing the start (the customer above the mail, the first input makes the draft).
 */
export function OfficeNewOrderRoute() {
  const search = useSearchParams()
  return search?.get('party') ? <NewOrderPage /> : <OfficeDraftPage />
}
