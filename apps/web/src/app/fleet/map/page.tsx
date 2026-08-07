/**
 * NAF.SB — Fleet map. The operator asked for "an extensive version of the
 * current one": full viewport rather than a panel, and an instrument rather
 * than a picture.
 *
 * Boundary against Workflows, stated once and enforced: the MAP is the whole
 * fleet as it is right now; WORKFLOWS are named routines you author. Airflow's
 * cluster view versus one DAG. If the two ever drift toward each other they
 * should merge, not both ship.
 */
import { FleetPageShell } from '../_shell/FleetPageShell'
import { PlannedPage } from '../_shell/PlannedPage'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <FleetPageShell
      title="Fleet map"
      sub="How the whole fleet fits together, live, on one canvas."
    >
      <PlannedPage
        purpose={
          <>
            The picture of who reads what, who hands work to whom, and what is running right now.
            This page is the fleet <i>as it is</i>; Workflows is where you change what it should
            be.
          </>
        }
        contents={[
          'Full viewport with a collapsible inspector rail, instead of a panel on a scrolling page.',
          'Three overlays over the same graph — autonomy (who may act), health (who is failing), cost (who is expensive).',
          'Live pulses while a run is in flight, and edge labels carrying how many findings or plans actually crossed.',
          'Filter by tier, marketplace or status; click a node for the worker, click an edge for the artifacts that crossed it.',
          'The entity graph — already built — as a second mode of the same canvas.',
        ]}
        needs={
          <>
            The graph endpoint exists and is already rendered on the Overview. The overlays need
            per-node aggregates the API does not compute yet: failure rate, spend and open
            findings rolled up per worker rather than joined in the browser.
          </>
        }
        livesToday={{ href: '/marketing/ads/fleet', label: 'the fleet Overview' }}
      />
    </FleetPageShell>
  )
}
