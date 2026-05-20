import { Suspense } from 'react'
import LiveClient from './_components/LiveClient'

export const dynamic = 'force-dynamic'

export default function InsightsLivePage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading live monitor…</div>}>
      <LiveClient />
    </Suspense>
  )
}
