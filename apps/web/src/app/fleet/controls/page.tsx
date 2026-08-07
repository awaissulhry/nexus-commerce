/**
 * NAF.SB.6 — Controls. docs/AGENT_FLEET.md Part 7 enumerates twenty controls
 * over the fleet; this gathers the runtime-editable ones into one place, in
 * Part 7's own order — bluntest first.
 */
import { ControlsClient } from './ControlsClient'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <div className="acr">
      <header className="acr-head">
        <div>
          <h1>Controls</h1>
          <p className="acr-sub">
            Everything that decides what the fleet is allowed to do — and one switch that stops
            all of it.
          </p>
        </div>
      </header>
      <ControlsClient />
    </div>
  )
}
