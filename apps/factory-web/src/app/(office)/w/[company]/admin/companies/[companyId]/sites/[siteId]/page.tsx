import { Suspense } from 'react'
import type { Metadata } from 'next'
import { SiteRecord } from '../../../../../../../../../areas/admin/sites/SiteRecord'

export const metadata: Metadata = { title: 'Site · Nexus Factory' }

/** Admin › Companies & sites › a company › a site (SCR-009; `?tab=structure|centres|calendars|devices|activity`). */
export default async function Page({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params
  return (
    <Suspense>
      <SiteRecord siteId={decodeURIComponent(siteId)} />
    </Suspense>
  )
}
