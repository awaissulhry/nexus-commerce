/**
 * NAF.SB — Approvals. The blocking queue: every archetype researched for the
 * page map has one (LangChain's Agent Inbox, UiPath's Action Center), and it is
 * the only fleet page that earns a permanent count badge in the rail.
 *
 * Shipped and working today as a section of the fleet Overview — AP.1–AP.8.
 * This route exists so the move has somewhere to land.
 */
import { FleetPageShell } from '../_shell/FleetPageShell'
import { PlannedPage } from '../_shell/PlannedPage'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <FleetPageShell
      title="Approvals"
      sub="Everything the fleet wants to do and cannot do until you say yes."
    >
      <PlannedPage
        purpose={
          <>
            Nothing the fleet proposes reaches Amazon without passing through this queue. One
            item, one decision — with the exact change it would make, what the critic said about
            it, and how far the damage would reach if it were wrong.
          </>
        }
        contents={[
          'One card per proposed action: the dry-run diff, the expected effect in euros, the critic’s notes, and the blast radius as a sentence.',
          'Four responses, not two — accept, edit, reject, or ask. Editing a proposal before it runs is the one thing the industry standard has that we do not.',
          'Bulk selection with a blast-radius sentence built server-side, so the confirmation cannot drift from the action.',
          'The twenty-second parked window with inline undo, and the expiry clock on every item.',
          'Reject-everything-from-one-worker, for the day a worker starts producing nonsense.',
          'Who decided, when, and what they were shown at the time.',
        ]}
        needs={
          <>
            Almost nothing — AP.1 to AP.8 already shipped the attribution, the brake, the expiry
            sweep, staleness and precedent. The one genuinely new piece is{' '}
            <b>edit-before-approve</b>, which needs an API that can accept an amended action and
            re-run it through the write gate rather than trusting the client’s version.
          </>
        }
        livesToday={{ href: '/fleet', label: 'the fleet Overview' }}
      />
    </FleetPageShell>
  )
}
