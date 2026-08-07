/**
 * NAF.SB.7 — the fleet's light surface.
 *
 * Moving out of /marketing/ads cost the fleet the ads console's shell, and that
 * shell was doing real work: `.h10-shell` sets `background: #f4f6f9; color:
 * #1c2530` and calls itself "this deliberately-light shell". The whole acr-*
 * family the fleet is built from hard-codes light values — `.acr-head h1` is
 * #1c2530, `.acr-sub` is #667485 — and carries no background of its own, so on
 * the app shell (which is slate-950 in dark mode) the headings rendered
 * near-invisible. Caught in the browser, not by tsc.
 *
 * The fix is the same decision the ads console already made rather than a new
 * one: pin this subtree light. Making the acr-* family theme-aware would mean
 * rewriting hundreds of hex values across control-room.css and
 * fleet-sections.css — two files owned by a parallel session — to solve a
 * problem the neighbouring console solved by scoping.
 *
 * The app RAIL still follows the app theme, which is correct: the rail belongs
 * to the app, only the content belongs to the fleet.
 */
import type { ReactNode } from 'react'
import './fleet-pages.css'

export default function FleetLayout({ children }: { children: ReactNode }) {
  return <div className="fleet-surface">{children}</div>
}
