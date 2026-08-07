/**
 * NAF.SB.AS / AS.1 — one assignment. The chain assignment → run → finding →
 * cost exists nowhere else in the fleet, because until this page there was no
 * assignment to hang it on.
 */
import { FleetPageShell } from '../../_shell/FleetPageShell'
import { AssignmentClient } from './AssignmentClient'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../../fleet-pages.css'
import '../assignments.css'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <FleetPageShell title="Assignment" sub="One worker, one thing to look at.">
      <AssignmentClient id={id} />
    </FleetPageShell>
  )
}
