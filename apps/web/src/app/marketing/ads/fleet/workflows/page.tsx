/**
 * NAF.SB — Workflows. The operator's connection ask: "a worker collects
 * information from several other workers, compiles it, sends it to another
 * worker, then other workers take a specific action without losing any
 * context."
 *
 * This is the page that carries the capability/composition split from Part 4 of
 * the proposal. Charter TYPES, tool grants and write paths stay in code, which
 * is what keeps laws L2 (agents get zero new write paths) and L3 (no agent may
 * spawn an agent) true. Wiring, scope, triggers and gates become versioned data
 * the canvas edits. The editor validates against the code layer on save: it
 * cannot draw an edge whose artifact type the target worker does not accept.
 */
import { FleetPageShell } from '../_shell/FleetPageShell'
import { PlannedPage } from '../_shell/PlannedPage'
import '../../rules-automation/control-room/control-room.css'
import '../fleet-pages.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <FleetPageShell
      title="Workflows"
      sub="The routines you author: who gathers, who compiles, who decides, who acts."
    >
      <PlannedPage
        purpose={
          <>
            A workflow is a named routine — one worker gathers, several report into it, it hands a
            compiled result to the next, and the last one acts or asks. You draw it, you version
            it, and you can test it without anything happening for real.
          </>
        }
        contents={[
          'A canvas per routine, with an explicit handoff contract on every edge: which artifact crosses, and which evidence travels with it.',
          'A trigger per routine — a schedule, an event, a button, or an assignment arriving.',
          'A gate on every step: act on its own, or stop and ask you.',
          'Version history with a diff and a rollback, because a behaviour change should be readable as a change.',
          'A test run that executes in dry-run and shows what would have happened, spending only the model call.',
          'The six run modes that exist in code today — tick, sweep, council, summit, incident, ask — seeded as working examples, so the page never opens as a blank canvas.',
        ]}
        needs={
          <>
            The largest build of the ten. Today the fleet graph is declared statically in code and
            the orchestrator walks that. This needs a stored, versioned workflow definition and an
            orchestrator that can execute one — plus the save-time validation that keeps the
            drawing honest about what each worker can actually accept and do.
          </>
        }
      />
    </FleetPageShell>
  )
}
