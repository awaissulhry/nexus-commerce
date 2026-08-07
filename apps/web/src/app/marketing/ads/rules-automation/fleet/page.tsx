/**
 * NAF.D2c — the Agent Fleet's own page (operator call 2026-08-06): first
 * child under the Rules & Automation chevron, promoted out of the Control
 * Room's tab bar. Same six panels, same acr-* styling — the stylesheet
 * still lives with the Control Room, whose visual family this page
 * belongs to.
 */
import { FleetTab } from './FleetTab'
import '../control-room/control-room.css'
// NAF.DT — the rebuilt sections live in their own stylesheet, so the
// parallel NAF.AC session keeps control-room.css to itself.
import './fleet-sections.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <div className="acr">
      <header className="acr-head">
        <div>
          <h1>Agent Fleet</h1>
          <p className="acr-sub">
            The LLM analyst fleet over the deterministic engines — findings, plans, the critic's
            verdicts, and every approval it is waiting on.
          </p>
        </div>
      </header>
      <FleetTab />
    </div>
  )
}
