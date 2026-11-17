import type { Metadata } from 'next'
import { Suspense } from 'react'
import { ServiceRecord } from '../../../../../../../areas/sales/service/record/ServiceRecord'

export const metadata: Metadata = { title: 'Service case · Nexus Factory' }

/** Sales › Warranty & service › a service case (SCR-413; `?tab=case|warranty|linked`, `&do=` a row verb's dialog; B-TH-259: old `actions` → linked, `activity` opens the thread). */
export default async function ServiceCaseRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <Suspense>
      <ServiceRecord caseId={decodeURIComponent(id)} />
    </Suspense>
  )
}
