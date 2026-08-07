/**
 * NAF.SB.4 — the worker registry page. First of the ten in
 * docs/2026-08-07-naf-sb-fleet-pages.md, built first because every control
 * plane researched for that document hangs everything else off one row per
 * agent.
 *
 * Styling: the acr-* family the rest of the fleet uses, plus fleet-pages.css —
 * the SB seam, so the sessions rebuilding control-room.css and
 * fleet-sections.css keep those files to themselves.
 */
import { WorkersClient } from './WorkersClient'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <div className="acr">
      <header className="acr-head">
        <div>
          <h1>Workers</h1>
          <p className="acr-sub">
            Every AI worker in the fleet, what it is allowed to do, and how it has been doing it.
          </p>
        </div>
      </header>
      <WorkersClient />
    </div>
  )
}
