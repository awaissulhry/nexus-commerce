/** Ads Console — Bulk operations (download/upload bulksheets, Amazon format). */
import type { Metadata } from 'next'
import { BulkOpsClient } from './BulkOpsClient'

export const metadata: Metadata = { title: 'Bulk operations | Ads Console' }
export const dynamic = 'force-dynamic'

export default function AdsConsoleBulkPage() {
  return <BulkOpsClient />
}
