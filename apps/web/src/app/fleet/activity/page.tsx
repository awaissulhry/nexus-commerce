/**
 * NAF.SB.ACT — Activity: the fleet's record.
 *
 * Every orchestrator studied for the page map keeps the graph and the runs on
 * separate pages — the graph is the definition, a run is an instance, and
 * conflating them is a known novice mistake. This is the runs side, and it is
 * the only UNSCOPED one: `/fleet/workflows/[key]` shows one routine's runs,
 * `/fleet/workers/[key]` shows one worker's, `/fleet` shows the last few of
 * everything. Activity shows all of it, whatever produced it.
 *
 * The two audience-named tabs this page was originally scoped with (Decisions
 * / Runs) were dropped by operator decision 2026-08-07: runs are a strict
 * SUBSET of the stream — 53 of 119 events — and naming halves by audience
 * makes a beginner classify their own question before they have seen a row.
 * One list with a grain switch instead, which is where Braintrust, LangSmith
 * and Copilot Studio all independently landed.
 *
 * ACT.2 ships the list in the "Everything" grain. The grain switch, the filter
 * chips and the run drawer are ACT.3–ACT.5; the study is
 * docs/2026-08-07-naf-sbact-activity-page.md.
 *
 * Styling, and the order matters (see workers/page.tsx for the full note):
 * control-room.css carries the acr-* family, fleet-pages.css carries
 * `.fleet-surface` and the shared acr-pg-* primitives, activity.css is this
 * page's own. The four DS stylesheets are deliberately NOT imported yet —
 * nothing here renders a DS component. They become mandatory at ACT.3, when
 * the Runs grain brings in DataGrid.
 */
import { FleetPageShell } from '../_shell/FleetPageShell'
import { ActivityClient } from './ActivityClient'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'
import './activity.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <FleetPageShell
      title="Activity"
      sub="Everything the fleet has done, newest first — and every run that tried."
    >
      <ActivityClient />
    </FleetPageShell>
  )
}
