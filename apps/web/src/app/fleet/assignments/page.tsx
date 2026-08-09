/**
 * NAF.SB.AS / AS.1 — Assignments. The operator's ask #1: "if we have a
 * campaign, I want to assign that worker… and take action on that single
 * campaign."
 *
 * The target is the reason this page exists, and until AS.1 the fleet could
 * not honour one: scope bound at exactly one place (the observation call in
 * agent-executor.ts) and only for marketplace, while `scopeCampaignIds` was
 * stored, accepted and rendered as "N named campaigns" bound to nothing.
 * This page ships the enforcement rather than a fifth surface that displays
 * an unenforced control.
 *
 * Study: docs/2026-08-07-naf-sbas-assignments-page.md
 */
import { FleetPageShell } from '../_shell/FleetPageShell'
import { AssignmentsClient } from './AssignmentsClient'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'
import './assignments.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <FleetPageShell
      title="Assignments"
      sub="Give one worker one job on one thing, and watch it through."
      rootClass="as-page"
    >
      <AssignmentsClient />
    </FleetPageShell>
  )
}
