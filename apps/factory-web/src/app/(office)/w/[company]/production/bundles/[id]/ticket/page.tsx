import type { Metadata } from 'next'
import { Suspense } from 'react'
import { BundleTicketPdf } from '../../../../../../../../areas/production/bundles/ticket/BundleTicketPdf'

export const metadata: Metadata = { title: 'Ticket · Nexus Factory' }

/** Ticket PDF (design production.bundles tab:bd-tab-ticket), opened in a new tab from the Bundle record or the list. */
export default async function ProductionBundleTicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <BundleTicketPdf bundleId={id} />
    </Suspense>
  )
}
