import { Suspense } from 'react'
import AmazonReportsClient from './_components/AmazonReportsClient'

export const dynamic = 'force-dynamic'

export default function InsightsAmazonReportsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-6 text-slate-500">Loading Amazon reports…</div>
      }
    >
      <AmazonReportsClient />
    </Suspense>
  )
}
