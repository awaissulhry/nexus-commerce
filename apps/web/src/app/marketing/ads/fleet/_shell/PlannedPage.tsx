import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'

/**
 * NAF.SB.3 — the shared shape of a fleet page that exists as a route but not
 * yet as a feature.
 *
 * The scaffold is deliberately NOT an empty page or a "coming soon" card. FX.4's
 * teaching-empty-state rule already says what a panel with no data owes the
 * reader: what will appear here, when, and what has to be true first. A route
 * with no feature owes exactly the same three things, so it renders them.
 *
 * `livesToday` is the important one. Every page in the Operate group is a MOVE,
 * not an invention — the approval inbox, the timeline and the map are all
 * shipped and working on the fleet Overview right now. Sending the operator
 * there is the difference between a placeholder and a dead end.
 */
export function PlannedPage({
  purpose,
  contents,
  needs,
  livesToday,
}: {
  /** One sentence: what this page is for. Written for someone who has never
   *  seen the fleet. */
  purpose: ReactNode
  /** What will be on it, once built. */
  contents: ReactNode[]
  /** What has to be true first — honestly, including "an API that does not
   *  exist yet". */
  needs: ReactNode
  /** Where this capability lives in the meantime, if it lives anywhere. */
  livesToday?: { href: string; label: string }
}) {
  return (
    <div className="acr-fleet">
      <p className="acr-pg-intro">{purpose}</p>

      <section className="acr-card">
        <div className="acr-pg-planbody">
          <div className="acr-pg-planbadge">Not built yet</div>

          {livesToday ? (
            <p className="acr-pg-planlives">
              Until it is, this lives on{' '}
              <Link href={livesToday.href}>
                {livesToday.label} <ArrowRight size={12} aria-hidden />
              </Link>
            </p>
          ) : null}

          <div className="acr-pg-plangrid">
            <div>
              <h4>What will be here</h4>
              <ul className="acr-pg-planlist">
                {contents.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
            <div>
              <h4>What it needs first</h4>
              <p className="acr-pg-planneeds">{needs}</p>
            </div>
          </div>

          <p className="acr-pg-planfoot">
            The full page map, the research behind it and the order of build are in{' '}
            <code>docs/2026-08-07-naf-sb-fleet-pages.md</code>.
          </p>
        </div>
      </section>
    </div>
  )
}
