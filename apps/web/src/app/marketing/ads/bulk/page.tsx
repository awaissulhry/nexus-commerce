/** AX-IE.8 — Bulk operations: the bulksheet round trip on the current console. */
import type { Metadata } from 'next'
import { BulkClient } from './BulkClient'

export const metadata: Metadata = { title: 'Bulk operations | Ads' }
export const dynamic = 'force-dynamic'

export default function Page() {
  return <BulkClient />
}
