/**
 * NAF.WF.1 — Workflows: the fleet's named routines, read-only over the code
 * truth. Three built-ins (sweep · council · ask — the modes that actually
 * execute); the stored, versioned, operator-editable definition arrives with
 * WF.2+ per docs/2026-08-07-naf-wf-workflows-page.md. The capability/
 * composition split stands: charter types, tools and write paths stay in
 * code (laws L2/L3); this page renders — and will later edit — only the
 * wiring, triggers and gates.
 */
import { FleetPageShell } from '../_shell/FleetPageShell'
import { WorkflowsClient } from './WorkflowsClient'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'
import './workflows.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <FleetPageShell
      title="Workflows"
      sub="The fleet's named routines — who gathers, who compiles, who decides, and where you sit."
    >
      <WorkflowsClient />
    </FleetPageShell>
  )
}
