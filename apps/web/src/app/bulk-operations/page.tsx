import { Suspense } from 'react'
import Link from 'next/link'
import { History as HistoryIcon } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import ActiveJobsStrip from './ActiveJobsStrip'
import BulkOperationsClient from './BulkOperationsClient'

// U.46 — force-dynamic. Suspense alone (U.45) didn't unstick the
// App Router's transition queue on production. Forcing the route out
// of static-rendering attempts entirely eliminates the bailout-mode
// edge case that was poisoning router.push().
export const dynamic = 'force-dynamic'

// U.45 — root cause of the /bulk-operations navigation deadlock:
// BulkOperationsClient calls useSearchParams() (P.9, scoped IDs from
// the URL), which requires a Suspense boundary in production. Without
// one, Next.js silently bails the entire page out of static rendering
// and mismanages the App Router's transition queue — the symptom was
// router.push() running silently: no RSC fetch, no URL change, no
// console error. Even pushState + popstate updated the URL but the
// router never reacted.
//
// U.44's page-level 'use client' + mount-gate masked this by making
// the whole page CSR — but it also severed PageHeader's Link from the
// router. Both diagnostics pointed at the same boundary problem.
//
// Fix: server-render the shell (PageHeader, Link, ActiveJobsStrip)
// and wrap BulkOperationsClient in <Suspense> so useSearchParams has
// its required boundary. Next.js's prerender step now succeeds and
// the App Router's transitions stay healthy.
export default function BulkOperationsPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Bulk Operations"
        description="Click any cell to edit (Phase B) · Cmd+S to save"
        actions={
          <Link
            href="/bulk-operations/history"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-11 sm:min-h-0 text-base font-medium text-slate-700 bg-white border border-slate-200 rounded hover:border-slate-300 hover:bg-slate-50 transition-colors dark:text-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:hover:border-slate-700 dark:hover:bg-slate-800"
          >
            <HistoryIcon className="w-3.5 h-3.5" />
            Job History
          </Link>
        }
      />
      <ActiveJobsStrip />
      <Suspense
        fallback={
          <div
            role="status"
            aria-live="polite"
            className="text-md text-slate-500 dark:text-slate-400 py-12 text-center"
          >
            Loading bulk operations…
          </div>
        }
      >
        <BulkOperationsClient />
      </Suspense>
    </div>
  )
}
