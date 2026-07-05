'use client'

/**
 * CI.2 — Customer Segments page.
 *
 * Lists all defined customer cohorts (name, conditions, member count).
 * Operators can create segments via the SegmentBuilderDrawer, view members,
 * export CSV, and apply bulk tags.
 *
 * The API session cookie lives on the API origin (cross-site setup) — the
 * Next server can never present it, so data MUST load client-side where the
 * fetch patch adds credentials. Server-side this page 401'd into an empty
 * segments list.
 */

import { useEffect, useState } from 'react'
import { Filter } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { SegmentsClient } from './SegmentsClient'

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

export default function SegmentsPage() {
  const [segments, setSegments] = useState<Segment[] | null>(null)

  useEffect(() => {
    let alive = true
    fetchSegments().then((rows) => {
      if (alive) setSegments(rows)
    })
    return () => { alive = false }
  }, [])

  return (
    <div className="px-4 py-4 max-w-4xl" aria-busy={segments === null}>
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

      {segments === null ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 rounded-md border border-default dark:border-slate-800 bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
      ) : (
        <SegmentsClient initialSegments={segments} />
      )}
    </div>
  )
}
