import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PriceListRecord } from '../../../../../../../areas/sales/pricelists/record/PriceListRecord'

export const metadata: Metadata = { title: 'Price list · Nexus Factory' }

/** Sales › Price lists › a price list (SCR-106; `?tab=prices|customers|versions|activity`, `?version=<id>` on Prices). */
export default async function Page({ params }: { params: Promise<{ listId: string }> }) {
  const { listId } = await params
  return (
    <Suspense>
      <PriceListRecord listId={decodeURIComponent(listId)} />
    </Suspense>
  )
}
