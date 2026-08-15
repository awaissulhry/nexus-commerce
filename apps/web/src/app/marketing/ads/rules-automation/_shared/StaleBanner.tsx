'use client'

/**
 * RT.2 — the one "someone else changed this" control, shared by every page that polls a cursor.
 *
 * Bid, Budget and Placement each hand-rolled this button when their cursor shipped, and the copies
 * had already drifted in wording. Four more pages gaining a cursor is the moment that becomes a
 * fork, so this is the single implementation; the three older pages keep their inline markup until
 * their next unit touches them, and this is what they collapse onto.
 *
 * ── What it is careful about ────────────────────────────────────────────────────────────────────
 *
 *   · **It never says how many rows changed.** A cursor is a fingerprint, not a diff — it knows
 *     THAT something moved, never what. "3 rows changed" would be invented, and the operator would
 *     go looking for three rows.
 *   · **It only appears for someone ELSE'S change.** Your own writes arrive on the cross-tab rail
 *     and are already applied by the time this could render (`_shared/adsBus.ts`).
 *   · **It is a button, not a toast.** Nothing has moved yet; clicking is what moves it. That is
 *     the section's rule 1 — never yank rows out from under someone reading.
 */
import { RefreshCw } from 'lucide-react'

export function StaleBanner({ stale, subject, onRefresh }: {
  stale: boolean
  /** what moved, in the page's own noun — "a bid, a target or a campaign" */
  subject: string
  onRefresh: () => void
}) {
  if (!stale) return null
  return (
    <button
      type="button"
      className="h10-bd-stale"
      onClick={onRefresh}
      title={`${subject} changed since this view was loaded. Nothing has been reordered underneath you — click to pick it up.`}
    >
      <RefreshCw size={12} aria-hidden /> Changed since you loaded
    </button>
  )
}
