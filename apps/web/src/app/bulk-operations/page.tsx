import Link from 'next/link'
import { CalendarClock, History as HistoryIcon } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import ActiveJobsStrip from './ActiveJobsStrip'
import BulkOperationsClient from './BulkOperationsClient'

export const dynamic = 'force-dynamic'

/**
 * Server shell only — does NOT fetch data on the server.
 *
 * At 10k+ rows, server-fetching means Next.js inlines the entire JSON
 * payload into the HTML response (~6 MB before gzip), which blows past
 * the <1s page-load target. Instead the client component fetches on
 * mount, gets a small (gzipped) JSON payload directly, and renders
 * progressively.
 */
export default function BulkOperationsPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Bulk Operations"
        description="Click any cell to edit (Phase B) · Cmd+S to save"
        actions={
          <div className="flex items-center gap-1.5">
            <Link
              href="/bulk-operations/schedules"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-11 sm:min-h-0 text-base font-medium text-slate-700 bg-white border border-slate-200 rounded hover:border-slate-300 hover:bg-slate-50 transition-colors dark:text-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:hover:border-slate-700 dark:hover:bg-slate-800"
            >
              <CalendarClock className="w-3.5 h-3.5" />
              Schedules
            </Link>
            <Link
              href="/bulk-operations/history"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-11 sm:min-h-0 text-base font-medium text-slate-700 bg-white border border-slate-200 rounded hover:border-slate-300 hover:bg-slate-50 transition-colors dark:text-slate-300 dark:bg-slate-900 dark:border-slate-800 dark:hover:border-slate-700 dark:hover:bg-slate-800"
            >
              <HistoryIcon className="w-3.5 h-3.5" />
              Job History
            </Link>
          </div>
        }
      />
      <ActiveJobsStrip />
      <BulkOperationsClient />
    </div>
  )
}
