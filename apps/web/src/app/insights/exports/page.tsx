import { Suspense } from 'react'
import ExportsClient from './_components/ExportsClient'

export const dynamic = 'force-dynamic'

export default function InsightsExportsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading export hub…</div>}>
      <ExportsClient />
    </Suspense>
  )
}
