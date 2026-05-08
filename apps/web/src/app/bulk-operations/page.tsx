import Link from 'next/link'
import { History as HistoryIcon } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import ActiveJobsStrip from './ActiveJobsStrip'
import BulkOperationsClient from './BulkOperationsClientWrapper'

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
// U.38 — simplified the page wrapper. The earlier layout used
// `-mx-6 -my-6` to escape the layout's p-6 padding plus a hardcoded
// `h-[calc(100dvh-1.5rem)]` to anchor the grid to the viewport. That
// combination caused weird side effects (scroll context confusion +
// the sidebar's md:sticky context didn't compose cleanly with main's
// own scroll) — the user reported they couldn't navigate to other
// sidebar links from this page.
//
// Now: a normal `space-y-3` page that lives inside the layout's
// padding like every other page. The grid scroll container sets its
// own max-height in BulkOperationsClient, so it still anchors at the
// bottom of the viewport on desktop, but the page itself doesn't
// fight the layout for height.
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
