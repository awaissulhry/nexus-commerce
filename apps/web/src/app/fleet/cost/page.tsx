/**
 * NAF.SB — Cost & value. ServiceNow's AI Control Tower makes the point this
 * page is built on: a spend number alone does not support a decision. Their
 * Value dashboard pairs cost with ROI, cost avoidance and — the useful part —
 * ADOPTION BLOCKERS: what is actually stopping a thing being used more.
 *
 * For us that translates directly. "$0.38 spent" tells the operator nothing.
 * "This worker costs $0.02 per accepted action and has moved €140" tells them
 * whether to promote it.
 */
import { FleetPageShell } from '../_shell/FleetPageShell'
import { PlannedPage } from '../_shell/PlannedPage'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <FleetPageShell
      title="Cost & value"
      sub="What the fleet costs, what it moved, and which workers pay for themselves."
    >
      <PlannedPage
        purpose={
          <>
            Spend on its own is not a decision. This page pairs every euro the fleet costs with
            what that euro did — so promoting a worker, or switching one off, is a judgement you
            can defend rather than a feeling.
          </>
        }
        contents={[
          'Spend by worker, by tier and by model, and the burn-down against the daily ceiling.',
          'Cost per accepted action, and cost per euro of ad spend actually moved.',
          'Which workers pay for themselves, and which are pure overhead.',
          'Outcome attribution — what the account did after an action was executed, not just that it was executed.',
          'Adoption blockers: for every worker not yet promoted, the specific thing it still owes — days in OBSERVE, a grade, an open rollback.',
        ]}
        needs={
          <>
            Per-step cost is already recorded on every run, so the spend half could be built
            today. The value half cannot: attribution is the Auditor’s job and the Auditor has
            never run. Building the whole page before then would mean designing the important
            column against an empty table.
          </>
        }
        livesToday={{ href: '/fleet', label: 'the fleet Overview' }}
      />
    </FleetPageShell>
  )
}
