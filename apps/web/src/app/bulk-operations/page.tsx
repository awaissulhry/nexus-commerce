// U.50 (BISECT 1/N) — re-introduce ActiveJobsStrip on top of U.49's
// minimum repro. If clicks still navigate after this deploy, the strip
// is innocent and we move on to bisecting BulkOperationsClient itself.
// If clicks die, the strip's polling fetch / Link / state is the
// culprit.
import Link from 'next/link'
import PageHeader from '@/components/layout/PageHeader'
import ActiveJobsStrip from './ActiveJobsStrip'
import BulkOperationsClient from './BulkOperationsClient'

export const dynamic = 'force-dynamic'

export default function BulkOperationsPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Bulk Operations (BISECT 2 — U.51)"
        description="BulkOps hooks load but JSX render is stubbed. Click any link."
      />
      <ActiveJobsStrip />
      <BulkOperationsClient />
      <div className="rounded-lg border border-amber-300 bg-amber-50 p-6 dark:bg-amber-900/20 dark:border-amber-700">
        <p className="text-base text-amber-900 dark:text-amber-200">
          BulkOperationsClient + ActiveJobsStrip are temporarily disabled
          to isolate a navigation deadlock. Test clicks below and on the
          sidebar:
        </p>
        <ul className="mt-3 list-disc list-inside space-y-1 text-base">
          <li>
            <Link
              href="/products"
              className="text-blue-700 underline hover:text-blue-900 dark:text-blue-400"
            >
              In-page Link → /products
            </Link>
          </li>
          <li>
            <Link
              href="/orders"
              className="text-blue-700 underline hover:text-blue-900 dark:text-blue-400"
            >
              In-page Link → /orders
            </Link>
          </li>
          <li>
            <Link
              href="/bulk-operations/history"
              className="text-blue-700 underline hover:text-blue-900 dark:text-blue-400"
            >
              In-page Link → /bulk-operations/history
            </Link>
          </li>
        </ul>
      </div>
    </div>
  )
}
