import { Suspense } from 'react'
import CostGridClient from './CostGridClient'

export const dynamic = 'force-dynamic'

export default function ProductCostsPage() {
  return (
    <Suspense
      fallback={<div className="p-6 text-slate-500">Loading costs…</div>}
    >
      <CostGridClient />
    </Suspense>
  )
}
