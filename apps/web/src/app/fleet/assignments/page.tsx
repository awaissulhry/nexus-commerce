/**
 * NAF.SB — Assignments. The operator's first ask: "if we have a campaign, I
 * want to assign that worker… and take action on that single campaign."
 *
 * The model comes from UiPath Orchestrator, the one archetype the master brief
 * never considered: work is DATA, not code. You put an item in a queue, a
 * trigger starts a job when items arrive, and the item carries a state through
 * its life. "Assign that worker to this campaign" is literally a queue item.
 *
 * This also gives the `ask` run mode a home. 43 of the 45 runs this fleet has
 * ever done were `ask`, driven from scripts, with no interface at all.
 */
import { FleetPageShell } from '../_shell/FleetPageShell'
import { PlannedPage } from '../_shell/PlannedPage'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <FleetPageShell
      title="Assignments"
      sub="Give one worker one job on one thing, and watch it through."
    >
      <PlannedPage
        purpose={
          <>
            Point a named worker at a named thing. Pick the worker, pick the campaign or product
            or keyword set, say what you want back and by when, and say whether it may act or must
            propose. Then watch it move through its states until it is done.
          </>
        }
        contents={[
          'Create: worker → target (campaign, portfolio, ad group, product, keyword set, marketplace) → what you want back → deadline → may it act, or must it ask.',
          'A life you can see: New → Running → Produced N findings → Awaiting your approval → Done. Plain words over the queue-item states the industry uses.',
          'Attach a file to an assignment, so a worker can be pointed at your list rather than the whole account.',
          'Bulk-create from a selection or an uploaded sheet — one assignment per row.',
          'Make it recurring, and it becomes a trigger rather than a one-off.',
          'Every assignment links to the run it produced and the approvals that came out of it.',
        ]}
        needs={
          <>
            A new <code>AgentAssignment</code> table with queue semantics, and the routes to
            create and advance one. The executor and the scope system it would drive already
            exist — this is mostly a new noun, not new machinery.
          </>
        }
      />
    </FleetPageShell>
  )
}
