import { Suspense } from 'react'
import AnomaliesClient from './_components/AnomaliesClient'

export const dynamic = 'force-dynamic'

export default function InsightsAnomaliesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading anomaly detection…</div>}>
      <AnomaliesClient />
    </Suspense>
  )
}
