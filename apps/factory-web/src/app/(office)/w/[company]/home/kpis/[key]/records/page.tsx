import type { Metadata } from 'next'
import { Suspense } from 'react'
import { RecordsPage } from '../../../../../../../../areas/home/kpis/RecordsPage'

export const metadata: Metadata = { title: 'KPI records · Nexus Factory' }

/** Home › Insights › KPI library › a KPI › the records behind it (SCR-471, B-W2b-429's drills). */
export default function HomeKpiRecordsPage() {
  return (
    <Suspense>
      <RecordsPage />
    </Suspense>
  )
}
