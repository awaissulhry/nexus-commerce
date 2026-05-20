import { Suspense } from 'react'
import InsightsLanding from './_components/InsightsLanding'

export const dynamic = 'force-dynamic'

export default function InsightsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading insights…</div>}>
      <InsightsLanding />
    </Suspense>
  )
}
