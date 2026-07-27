'use client'

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react'
import type { StalenessEntry } from './types'

/**
 * Amber "stale" / green "in sync" pill for a set of products. eBay HTML is
 * static — this is the operator's only signal that the live description has
 * drifted behind the Image-Manager curation or a theme edit. Clicking a stale
 * pill runs `onClickStale` (the one-click re-push wiring) and expands the
 * per-product reasons; it NEVER pushes anything by itself.
 *
 * DS-1 additions:
 *  - `checkError`: the staleness FETCH failed → a gray "unknown" pill,
 *    deliberately distinct from green. A failed check must never look like
 *    "in sync" — unknown freshness is not freshness.
 *  - reason-aware header: families that were simply never pushed read
 *    "never pushed", not the alarming "images or theme changed".
 */
export function StalenessPill({ entries, skuById, onClickStale, checkError }: {
  entries: StalenessEntry[]
  skuById: Record<string, string>
  onClickStale?: () => void
  /** Set when the staleness fetch itself failed — renders the gray unknown pill. */
  checkError?: string | null
}) {
  const [expanded, setExpanded] = useState(false)
  if (checkError) {
    return (
      <span
        className="inline-flex items-center gap-1 self-start rounded-full border border-slate-300 dark:border-slate-600 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-500 dark:text-slate-400"
        title={`The staleness check failed — freshness is UNKNOWN, not fresh. ${checkError}`}
        data-testid="description-staleness-unknown"
      >
        <HelpCircle className="w-3 h-3" /> Staleness unknown — check failed
      </span>
    )
  }
  if (entries.length === 0) return null
  const staleEntries = entries.filter((e) => e.stale)

  if (staleEntries.length === 0) {
    const at = entries.map((e) => e.stampedAt).filter(Boolean)[0]
    return (
      <span
        className="inline-flex items-center gap-1 self-start rounded-full border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300"
        title={at ? `Last description push stamped ${new Date(at).toLocaleString()}` : 'Images and theme match the last description push'}
        data-testid="description-staleness-fresh"
      >
        <CheckCircle2 className="w-3 h-3" /> In sync with last push
      </span>
    )
  }

  // DS-1 — reason-aware header: "never pushed" families are not the same story
  // as drift after a push (the endpoint's never-pushed reasons all contain
  // "never … pushed"; see evaluateDescriptionStaleness).
  const neverPushedOnly = staleEntries.every((e) => e.reasons.every((r) => /never (been )?pushed/i.test(r)))
  const header = neverPushedOnly
    ? 'Description never pushed to this market yet'
    : 'Description stale — images or theme changed since last push'

  const reasonLines = staleEntries.map(
    (e) => `${skuById[e.productId] ?? e.productId}: ${e.reasons.join('; ')}`,
  )
  return (
    <span className="flex flex-col gap-1 self-start" data-testid="description-staleness-stale">
      <button
        type="button"
        onClick={() => { setExpanded((v) => !v); onClickStale?.() }}
        title={`${reasonLines.join('\n')}\n\nClick to ${onClickStale ? 're-push from the Push dock' : expanded ? 'collapse the reasons' : 'see the reasons'}`}
        className="inline-flex items-center gap-1 self-start rounded-full border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 transition-colors"
      >
        <AlertTriangle className="w-3 h-3" />
        {header}
        {entries.length > 1 && <span className="font-normal">({staleEntries.length}/{entries.length} products)</span>}
      </button>
      {expanded && (
        <span className="flex flex-col gap-0.5 rounded border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/20 px-2 py-1">
          {staleEntries.map((e) => (
            <span key={e.productId} className="text-[10px] text-amber-800 dark:text-amber-300">
              <span className="font-semibold">{skuById[e.productId] ?? e.productId}</span> — {e.reasons.join(' · ')}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}
