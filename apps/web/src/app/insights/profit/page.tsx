import { Suspense } from 'react'
import ProfitClient from './_components/ProfitClient'

export const dynamic = 'force-dynamic'

export default function ProfitPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading profit report…</div>}>
      <ProfitClient />
    </Suspense>
  )
}
