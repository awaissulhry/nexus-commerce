'use client'

import { Card } from '@/components/ui/Card'
import RelativeTimestamp from './RelativeTimestamp'
import type { OverviewPayload, T } from '../_lib/types'

/**
 * Recent activity feed. Today this is BulkOperation + AuditLog
 * merged; W3 expands it into a true cross-system event stream
 * (orders, shipments, listings, syncs, suppressions, customers)
 * powered by SSE.
 */
export default function ActivityFeed({
  t,
  items,
}: {
  t: T
  items: OverviewPayload['recentActivity']
}) {
  if (items.length === 0) return null
  return (
    <Card title={t('overview.activity.heading')} noPadding>
      <ul className="max-h-[260px] overflow-y-auto">
        {items.map((a, idx) => (
          <li
            key={idx}
            className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 last:border-b-0 flex items-start justify-between gap-3"
          >
            <div className="text-sm text-slate-700 dark:text-slate-300 break-words flex-1">
              {a.summary}
            </div>
            <RelativeTimestamp t={t} at={Date.parse(a.ts)} compact />
          </li>
        ))}
      </ul>
    </Card>
  )
}
