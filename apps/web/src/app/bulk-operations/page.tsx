import Link from 'next/link'
import { History as HistoryIcon } from 'lucide-react'
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
// U.12 — switched 100vh → 100dvh so iOS Safari's URL-bar hide/show
// doesn't clip the bottom of the grid. dvh is supported by every
// modern engine since 2024.
export default function BulkOperationsPage() {
  return (
    <div className="space-y-3 -mx-6 -my-6 h-[calc(100dvh-1.5rem)] flex flex-col">
      <div className="px-6 pt-6 flex-shrink-0">
        <PageHeader
          title="Bulk Operations"
          description="Click any cell to edit (Phase B) · Cmd+S to save"
          actions={
            <Link
              href="/bulk-operations/history"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 min-h-11 sm:min-h-0 text-base font-medium text-slate-700 bg-white border border-slate-200 rounded hover:border-slate-300 hover:bg-slate-50 transition-colors"
            >
              <HistoryIcon className="w-3.5 h-3.5" />
              Job History
            </Link>
          }
        />
      </div>
      <ActiveJobsStrip />
      <BulkOperationsClient />
    </div>
  )
}
