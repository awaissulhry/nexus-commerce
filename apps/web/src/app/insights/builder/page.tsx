import { Suspense } from 'react'
import BuilderClient from './_components/BuilderClient'

export const dynamic = 'force-dynamic'

export default function InsightsBuilderPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading report builder…</div>}>
      <BuilderClient />
    </Suspense>
  )
}
