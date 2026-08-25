'use client'

/**
 * HX.9 — changes, plotted on the performance chart.
 *
 * A change log answers "what did we change" and a performance chart answers "what happened". Read
 * apart, connecting them is guesswork. Google Ads' Performance tab annotates the chart with change
 * history for exactly this reason, and nothing in the Amazon third-party space does it well.
 *
 * THE DESIGN PROBLEM, AND THE DECISION
 * rank-defend moves bids and placement percentages every 15 minutes, so a marker on every day with
 * *any* change would be a marker on every single day — noise that hides the signal it exists to
 * show. So the default annotates only DISCRETE changes: status flips, budget edits, creates and
 * deletes, operator notes. The continuous ones (bid, ad-group bid, placement percentage) are behind
 * a toggle, because "did our bidding move that week" is sometimes exactly the question.
 *
 * The split is by FIELD, not by source. A rule pausing a campaign is automation and is absolutely
 * notable; an operator nudging one bid is manual and is not. Filtering on source would get both
 * backwards.
 *
 * Feeds off the unified change feed (HX.4) — the same rows the Change Log and the schedule drawer
 * read, so a marker here and a row there can never disagree.
 */
import { useEffect, useMemo, useState } from 'react'
import { Checkbox } from '@/design-system/primitives'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import { getBackendUrl } from '@/lib/backend-url'

interface RawChange {
  id: string; at: string; source: string
  origin: { kind: string; id: string | null; name: string }
  entity: { type: string; id: string; name: string | null }
  campaign: { id: string; name: string | null } | null
  field: string; oldValue: string | null; newValue: string | null; reason: string | null
  delivery: { state: string } | null
}

export interface DayAnnotation {
  date: string // YYYY-MM-DD, matching the chart's x-axis keys
  count: number
  failed: number
  items: RawChange[]
}

/** The fields rank-defend touches on its 15-minute cadence. Continuous, not discrete. */
const ROUTINE_FIELDS = new Set([
  'bid', 'defaultBid', 'PLACEMENT_TOP', 'PLACEMENT_REST_OF_SEARCH', 'PLACEMENT_PRODUCT_PAGE', 'placementBidding',
])

export const isRoutine = (field: string) => ROUTINE_FIELDS.has(field)

// Short, human labels for the marker tooltip. Anything unmapped falls back to the raw field, which
// is still more useful than hiding it.
const FIELD_LABEL: Record<string, string> = {
  status: 'Status', dailyBudget: 'Daily budget', name: 'Renamed',
  bid: 'Bid', defaultBid: 'Ad-group bid',
  PLACEMENT_TOP: 'Top-of-search bias', PLACEMENT_REST_OF_SEARCH: 'Rest-of-search bias', PLACEMENT_PRODUCT_PAGE: 'Product-page bias',
}
export const annotationLabel = (c: RawChange): string => {
  const what = FIELD_LABEL[c.field] ?? c.field.replace(/_/g, ' ').toLowerCase()
  const where = c.campaign?.name ?? c.entity.name ?? null
  const move = c.oldValue != null && c.newValue != null ? `${c.oldValue} → ${c.newValue}` : (c.newValue ?? '')
  return [what, move, where ? `· ${where}` : ''].filter(Boolean).join(' ')
}

/**
 * Fetches the change feed for the chart's own window and buckets it by local date.
 *
 * Bucketed on the LOCAL date, because the chart's x-axis is local days — bucketing on the UTC date
 * would slide every evening change onto the following day's marker for a Rome-based account.
 */
export function useChangeAnnotations(
  start: Date | null,
  end: Date | null,
  opts: { enabled: boolean; includeRoutine: boolean },
): { byDate: Map<string, DayAnnotation>; total: number; loading: boolean } {
  const [raw, setRaw] = useState<RawChange[]>([])
  const [loading, setLoading] = useState(false)
  const fromIso = start ? start.toISOString() : null
  const toIso = end ? end.toISOString() : null

  useEffect(() => {
    if (!opts.enabled || !fromIso || !toIso) { setRaw([]); return }
    let alive = true
    setLoading(true)
    const qs = new URLSearchParams({ from: fromIso, to: toIso, limit: '500' })
    void fetch(`${getBackendUrl()}/api/advertising/changes?${qs.toString()}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => { if (alive) setRaw(Array.isArray(j?.items) ? j.items : []) })
      .catch(() => { if (alive) setRaw([]) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [fromIso, toIso, opts.enabled])

  const byDate = useMemo(() => {
    const m = new Map<string, DayAnnotation>()
    for (const c of raw) {
      if (!opts.includeRoutine && isRoutine(c.field)) continue
      const d = new Date(c.at)
      // Local date key: `sv-SE` yields YYYY-MM-DD, which is what the chart's x-axis uses.
      const key = d.toLocaleDateString('sv-SE')
      const e = m.get(key) ?? { date: key, count: 0, failed: 0, items: [] }
      e.count++
      if (c.delivery?.state === 'FAILED') e.failed++
      if (e.items.length < 12) e.items.push(c) // the tooltip caps anyway; don't retain 500 rows per day
      m.set(key, e)
    }
    return m
  }, [raw, opts.includeRoutine])

  const total = useMemo(() => [...byDate.values()].reduce((n, d) => n + d.count, 0), [byDate])
  return { byDate, total, loading }
}

/** The control that turns annotations on and widens them to routine bid movement. */
export function AnnotationToggle({ on, onToggle, includeRoutine, onToggleRoutine, total }: {
  on: boolean; onToggle: (v: boolean) => void
  includeRoutine: boolean; onToggleRoutine: (v: boolean) => void
  total: number
}) {
  return (
    <span className="h10-gann-ctl">
      <Checkbox
        title="Mark the days something changed, so a move in the chart can be traced to what caused it."
        checked={on}
        onChange={(e) => onToggle(e.target.checked)}
        label={`Changes${on && total > 0 ? ` (${total})` : ''}`}
      />
      {on && (
        <Checkbox
          title="Bids and placement percentages move every 15 minutes. Off by default, because a marker on every day marks nothing."
          checked={includeRoutine}
          onChange={(e) => onToggleRoutine(e.target.checked)}
          label="include bid moves"
        />
      )}
    </span>
  )
}

/** The tooltip block appended to the chart's own hover card for an annotated day. */
export function AnnotationTooltipRows({ day }: { day: DayAnnotation }) {
  const shown = day.items.slice(0, 4)
  return (
    <div className="h10-gtt-ann">
      <div className="hd">
        {day.count} change{day.count === 1 ? '' : 's'}
        {day.failed > 0 && <span className="bad">{day.failed} failed to reach Amazon</span>}
      </div>
      {shown.map((c) => (
        <div className="it" key={c.id} title={c.reason ?? undefined}>
          <span className="src">{c.origin.name}</span>
          <span className="txt">{annotationLabel(c)}</span>
        </div>
      ))}
      {day.count > shown.length && <div className="more">+{day.count - shown.length} more</div>}
    </div>
  )
}
