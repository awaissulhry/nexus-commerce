import type { Metadata } from 'next'
import { Suspense } from 'react'
import { KpiPage } from '../../../../../../../areas/home/kpis/KpiPage'

export const metadata: Metadata = { title: 'KPI · Nexus Factory' }

/** Home › Insights › KPI library › a KPI (SCR-470, design home.kpis rec:KPI: Definition, Where used, History). */
export default function HomeKpiPage() {
  return (
    <Suspense>
      <KpiPage />
    </Suspense>
  )
}
