// U.49 (DIAGNOSTIC) — minimum repro. /bulk-operations stripped to a
// near-empty shell: only PageHeader + a Link. If sidebar Links AND the
// in-page test Link both work after this deploy, the bug lives inside
// BulkOperationsClient or its imports. If they still don't work, the
// bug is in the layout/sidebar/providers (rendered above this page).
//
// The page.tsx file is the swap point because changing it does NOT
// touch the layout-level chrome — so a positive result on this stub
// definitively localizes the bug to the page subtree.
import Link from 'next/link'
import PageHeader from '@/components/layout/PageHeader'

export const dynamic = 'force-dynamic'

export default function BulkOperationsPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Bulk Operations (DIAGNOSTIC STUB — U.49)"
        description="Temporary minimum repro. Click any link to verify navigation."
      />
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
