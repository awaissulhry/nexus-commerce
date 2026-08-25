'use client'

/**
 * FB.2 — what the server said about this scope, in one place, on all eleven pages.
 *
 * Four different sentences used to live in four different shapes: `h10-bd-note` inside the Bid and
 * Budget bars, `h10-plc-note` inside Placement's, and `h10-kt-blind` / `h10-ng-blind` /
 * `h10-sov-blind` OUTSIDE the bar entirely on the three pages that carry the portfolio blind spot.
 * Merging the bars forced a choice of home, and the answer is inside it, under the controls: these
 * are facts about the grain currently being used, not about the page.
 *
 * 🔴 The contradiction sentence is the SERVER's, rendered verbatim. `resolveScopeReach` refuses a
 * combination that can never resolve and writes the reason; rewording it here would give the
 * operator two explanations for one refusal, and only one of them would be maintained.
 */
import { AlertTriangle, Info } from 'lucide-react'

export function ScopeNotes({ applied, notes, contradiction, intersectionCopy }: {
  /** which grains the server said it applied, in the order they narrowed. `[]` when it says nothing. */
  applied?: string[]
  /** non-fatal facts about the grain — e.g. the portfolio blind spot */
  notes?: string[]
  /** set when the combination can never resolve; the server writes the sentence */
  contradiction?: string | null
  /** overrides the intersection sentence for a page whose evaluator ANDs differently */
  intersectionCopy?: (applied: string[]) => string
}) {
  const app = applied ?? []
  const ns = notes ?? []
  if (!contradiction && app.length < 2 && ns.length === 0) return null

  return (
    <>
      {contradiction && (
        <p className="h10-ra-note warn">
          <AlertTriangle size={12} />
          <span><b>Nothing can match this scope.</b> {contradiction}</span>
        </p>
      )}

      {/* Stated only past one grain, since one grain cannot intersect with anything. */}
      {!contradiction && app.length > 1 && (
        <p className="h10-ra-note">
          <Info size={12} />
          <span>
            <b>{app.join(' + ')}</b>{' '}
            {intersectionCopy
              ? intersectionCopy(app)
              : 'narrow these rows together — the same intersection a rule scoped this way would reach.'}
          </span>
        </p>
      )}

      {ns.map((n) => (
        <p className="h10-ra-note" key={n}>
          <Info size={12} />
          <span>{n.charAt(0).toUpperCase()}{n.slice(1)}{/\.$/.test(n) ? '' : '.'}</span>
        </p>
      ))}
    </>
  )
}
