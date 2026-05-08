import Link from 'next/link'
import { History as HistoryIcon } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import ActiveJobsStrip from './ActiveJobsStrip'
import BulkOperationsClient from './BulkOperationsClient'

// U.45 — reverted U.44's page-level two-pass mount. The mount-gate
// gated PageHeader + Link behind a setMounted=true tick, which broke
// the Link's connection to Next.js's app-router transition queue:
// router.push() ran silently with no RSC fetch and no URL change,
// even though the Link's __reactProps$ were attached.
//
// Verified diagnosis: window.history.pushState + popstate updates
// the URL but Next.js's router never reacts on this page. Hard nav
// (location.href = …) works. No console errors, no hydration warnings,
// so U.41 (BulkOperationsClient lazy-init fix) + U.42 (use-recently-
// viewed lazy-init fix) are sufficient on their own.
//
// Now: server shell renders PageHeader + Link normally. The heavy
// client component (BulkOperationsClient) hydrates as a client island
// and its localStorage reads happen safely in useEffect.
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
      <BulkOperationsClient />
    </div>
  )
}
