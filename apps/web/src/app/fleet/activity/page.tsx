/**
 * NAF.SB — Activity. Every orchestrator studied for the page map keeps the
 * graph and the runs on separate pages: the graph is the definition, a run is
 * an instance, and conflating them is a known novice mistake. Two tabs here
 * because business decisions and technical executions are different questions.
 */
import { FleetPageShell } from '../_shell/FleetPageShell'
import { PlannedPage } from '../_shell/PlannedPage'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <FleetPageShell
      title="Activity"
      sub="Everything the fleet has done, newest first — and every run that tried."
    >
      <PlannedPage
        purpose={
          <>
            What has this thing been doing, and why. Two tabs: <b>Decisions</b> is the business
            story — who found what, who chose it, what the critic ruled. <b>Runs</b> is the
            technical one — what actually executed, how long it took, what it cost, and what
            broke.
          </>
        }
        contents={[
          'Decisions: the event stream over five tables, grouped by day and by episode, with filters by worker, kind, outcome and date.',
          'Runs: one row per run with mode, duration, tokens, cost — and the failure reason, which has no home anywhere today.',
          'Either one opens the full step trace: what it read, what it thought, what it wrote, what it cost.',
          'Export, and a permalink per event, so a decision can be quoted somewhere else.',
        ]}
        needs={
          <>
            DT.1–DT.3 already built the stream. DT.4 (the trace view) and DT.5 (filters and
            export) are scoped and open. The Runs tab needs no new API at all — it is the
            existing runs endpoint, read honestly.
          </>
        }
        livesToday={{ href: '/fleet', label: 'the fleet Overview' }}
      />
    </FleetPageShell>
  )
}
