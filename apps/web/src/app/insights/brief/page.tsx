import { Suspense } from 'react'
import BriefClient from './_components/BriefClient'

export const dynamic = 'force-dynamic'

export default function InsightsBriefPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading executive brief…</div>}>
      <BriefClient />
    </Suspense>
  )
}
