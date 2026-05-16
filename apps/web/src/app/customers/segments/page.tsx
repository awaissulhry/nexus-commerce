/**
 * CI.2 — Customer Segments page.
 *
 * Lists all defined customer cohorts (name, conditions, member count).
 * Operators can create segments via the SegmentBuilderDrawer, view members,
 * export CSV, and apply bulk tags.
 */

import { Filter } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { SegmentsClient } from './SegmentsClient'

export const dynamic = 'force-dynamic'

interface Segment {
  id: string
  name: string
  description: string | null
  conditions: Array<{ field: string; op: string; value?: unknown }>
  customerCount: number
  lastCountedAt: string | null
  createdAt: string
}

async function fetchSegments(): Promise<Segment[]> {
  try {
    const res = await fetch(`${getBackendUrl()}/api/customers/segments`, {
      cache: 'no-store',
    })
    if (!res.ok) return []
    const json = (await res.json()) as { segments: Segment[] }
    return json.segments
  } catch {
    return []
  }
}

export default async function SegmentsPage() {
  const segments = await fetchSegments()

  return (
    <div className="px-4 py-4 max-w-4xl">
      <div className="flex items-start gap-3 mb-5">
        <Filter className="h-6 w-6 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Customer Segments
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            Named customer cohorts defined by multi-field filter conditions.
            Use segments to export emails, apply tags, or schedule review requests.
          </p>
        </div>
      </div>

      <SegmentsClient initialSegments={segments} />
    </div>
  )
}
