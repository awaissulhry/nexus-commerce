/**
 * RX.1 — Review import workspace.
 *
 * Paste or upload a CSV/JSON/XLSX export (Seller Central Voice-of-the-
 * Customer, eBay feedback, Judge.me/Loox), auto-map the columns, preview
 * validation + dedup, then ingest through the shared sentiment pipeline.
 */

import { Upload } from 'lucide-react'
import { ReviewsNav } from '../_shared/ReviewsNav'
import { ImportClient } from './ImportClient'

export const dynamic = 'force-dynamic'

export default function ReviewImportPage() {
  return (
    <div className="px-4 py-4">
      <div className="flex items-start gap-3 mb-3">
        <Upload className="h-6 w-6 text-blue-500 dark:text-blue-400 mt-0.5" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Import reviews
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Bring real review text into the loop. Paste or upload an export — we auto-detect
            the columns, validate + dedup, then run sentiment + categorisation on every new
            row. Idempotent: re-importing the same file is safe.
          </p>
        </div>
      </div>

      <ReviewsNav />
      <ImportClient />
    </div>
  )
}
