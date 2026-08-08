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
 * the four DS stylesheets first — ACT.3's "Runs only" grain renders a DS
 * `DataGrid`, and a DS component without its stylesheet renders unstyled (the
 * Sync Control dropdown bug) — then control-room.css for the acr-* family,
 * then fleet-pages.css for `.fleet-surface` and the shared acr-pg-* primitives,
 * then this page's own.
 */
import { ActivityClient } from './ActivityClient'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'
import './activity.css'

export const dynamic = 'force-dynamic'

/**
 * S1R — `FleetPageShell` moved INTO the client component.
 *
 * The header's right-hand slot now carries the freshness instrument, and
 * freshness is client state (the last successful read, its age, the last
 * error). A server component cannot pass it, so the client owns the shell and
 * this file owns only the page's identity: the route, the stylesheets, and the
 * `.sba-page` root that scopes Activity's page-local overrides so they cannot
 * leak to a sibling fleet page across a client-side navigation.
 *
 * The title and the one-sentence purpose are unchanged and still verbatim from
 * the stub — they moved file, not wording.
 */
export default function Page() {
  return (
    <div className="sba-page">
      <ActivityClient />
    </div>
  )
}
