import { Suspense } from 'react'
import CustomersClient from './_components/CustomersClient'

export const dynamic = 'force-dynamic'

export default function InsightsCustomersPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading customer insights…</div>}>
      <CustomersClient />
    </Suspense>
  )
}
