import { Suspense } from 'react'
import SalesClient from './_components/SalesClient'

export const dynamic = 'force-dynamic'

export default function SalesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading sales report…</div>}>
      <SalesClient />
    </Suspense>
  )
}
