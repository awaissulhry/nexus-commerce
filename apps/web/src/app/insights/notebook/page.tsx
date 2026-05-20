import { Suspense } from 'react'
import NotebookClient from './_components/NotebookClient'

export const dynamic = 'force-dynamic'

export default function InsightsNotebookPage() {
  return (
    <Suspense fallback={<div className="p-6 text-slate-500">Loading notebook…</div>}>
      <NotebookClient />
    </Suspense>
  )
}
