'use client'

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
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="px-4 py-3 border-b border-slate-100">
        <h2 className="text-md font-semibold text-slate-900">
          {t('overview.activity.heading')}
        </h2>
      </div>
      <ul className="max-h-[260px] overflow-y-auto">
        {items.map((a, idx) => (
          <li
            key={idx}
            className="px-4 py-2 border-b border-slate-100 last:border-b-0 flex items-start justify-between gap-3"
          >
            <div className="text-sm text-slate-700 break-words flex-1">
              {a.summary}
            </div>
            <RelativeTimestamp t={t} at={Date.parse(a.ts)} compact />
          </li>
        ))}
      </ul>
    </div>
  )
}
