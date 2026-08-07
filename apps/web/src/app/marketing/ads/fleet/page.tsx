/**
 * NAF.SB.1 — the Agent Fleet's own rail section (operator call 2026-08-07).
 * It stopped being a chevron child of Rules & Automation because it is not a
 * kind of rule: the fleet governs LLM agents, the room governs deterministic
 * engines. It is expected to grow several pages of its own, which a chevron
 * child cannot carry.
 *
 * INTERIM SHAPE — this file is a route, not a home. The components still live
 * at ../rules-automation/fleet/ because a parallel session is editing them
 * right now; moving the directory under them would destroy their work. This
 * page therefore renders them from where they sit, and /marketing/ads/fleet is
 * the canonical URL from today. The cleanup pass (NAF.SB.2, once that session
 * lands) does the physical `git mv` into this directory, redirects the old
 * route, and updates the in-page links plus the two hrefs in
 * fleet-timeline.service.ts. Until then the old URL still renders — nothing is
 * broken, only duplicated, and only for the length of one session.
 *
 * The route move is CSS-safe: no class used by the fleet components is defined
 * only in rules-automation.css, the stylesheet the old subtree layout loaded.
 */
import { FleetTab } from '../rules-automation/fleet/FleetTab'
import '../rules-automation/control-room/control-room.css'
import '../rules-automation/fleet/fleet-sections.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <div className="acr">
      <header className="acr-head">
        <div>
          <h1>Agent Fleet</h1>
          <p className="acr-sub">
            The LLM analyst fleet over the deterministic engines — findings, plans, the critic&apos;s
            verdicts, and every approval it is waiting on.
          </p>
        </div>
      </header>
      <FleetTab />
    </div>
  )
}
