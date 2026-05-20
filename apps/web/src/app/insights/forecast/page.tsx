import { Suspense } from 'react'
import ForecastClient from './_components/ForecastClient'

export const dynamic = 'force-dynamic'

export default function InsightsForecastPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading forecast…</div>}>
      <ForecastClient />
    </Suspense>
  )
}
