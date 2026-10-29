import { Suspense } from 'react'
import type { Metadata } from 'next'
import { CompanyRecord } from '../../../../../../../areas/admin/companies/CompanyRecord'

export const metadata: Metadata = { title: 'Company · Nexus Factory' }

/** Admin › Companies & sites › a company (SCR-008 Company record; `?tab=legal|sites|defaults|activity`). */
export default async function Page({ params }: { params: Promise<{ companyId: string }> }) {
  const { companyId } = await params
  return (
    <Suspense>
      <CompanyRecord companyId={decodeURIComponent(companyId)} />
    </Suspense>
  )
}
