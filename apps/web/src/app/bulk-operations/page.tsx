import PageHeader from '@/components/layout/PageHeader'
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
    <div className="space-y-3 -mx-6 -my-6 h-[calc(100vh-1.5rem)] flex flex-col">
      <div className="px-6 pt-6 flex-shrink-0">
        <PageHeader
          title="Bulk Operations"
          description="Click any cell to edit (Phase B) · Cmd+S to save"
        />
      </div>
      <BulkOperationsClient />
    </div>
  )
}
