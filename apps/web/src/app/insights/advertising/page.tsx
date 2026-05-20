import { Suspense } from 'react'
import AdvertisingClient from './_components/AdvertisingClient'

export const dynamic = 'force-dynamic'

export default function AdvertisingInsightsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading advertising report…</div>}>
      <AdvertisingClient />
    </Suspense>
  )
}
