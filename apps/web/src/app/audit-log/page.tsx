import PageHeader from '@/components/layout/PageHeader'
import AuditLogClient from './AuditLogClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Audit log browser. Surfaces every mutation written to the AuditLog
 * table — products, listings, prices, PIM, AI ops, etc. — with
 * filter chips for entityType + action, free-text search, date range,
 * and per-row before/after diff drill-down.
 *
 * Pre-this page, audit data was append-only with no read surface.
 * Compliance + debugging both required raw SQL access.
 */
export default function AuditLogPage() {
  return (
    <div className="space-y-3">
      <PageHeader
        title="Audit Log"
        description="Every mutation across the platform · filter, search, drill into before/after diffs"
        breadcrumbs={[{ label: 'Audit Log' }]}
      />
      <AuditLogClient />
    </div>
  )
}
