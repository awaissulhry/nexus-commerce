import { Suspense } from 'react'
import FiscalClient from './_components/FiscalClient'

export const dynamic = 'force-dynamic'

export default function InsightsFiscalPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading fiscal report…</div>}>
      <FiscalClient />
    </Suspense>
  )
}
