import { Suspense } from 'react'
import ScenariosClient from './_components/ScenariosClient'

export const dynamic = 'force-dynamic'

export default function InsightsScenariosPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading scenarios…</div>}>
      <ScenariosClient />
    </Suspense>
  )
}
