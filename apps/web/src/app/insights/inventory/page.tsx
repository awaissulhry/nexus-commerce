import { Suspense } from 'react'
import InventoryClient from './_components/InventoryClient'

export const dynamic = 'force-dynamic'

export default function InsightsInventoryPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading inventory insights…</div>}>
      <InventoryClient />
    </Suspense>
  )
}
