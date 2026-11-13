import { Suspense } from 'react'
import type { Metadata } from 'next'
import { PriceListPrint } from '../../../../../../../../areas/sales/pricelists/print/PriceListPrint'

export const metadata: Metadata = { title: 'Price list PDF · Nexus Factory' }

/** Sales › Price lists › a price list on paper or as a PDF (SCR-420, a new tab, design tab:pricelists.pdf): `?version=<id>`. */
export default async function Page({ params }: { params: Promise<{ listId: string }> }) {
  const { listId } = await params
  return (
    <Suspense>
      <PriceListPrint listId={decodeURIComponent(listId)} />
    </Suspense>
  )
}
