/**
 * NAF.SB — Files & data. The operator's upload ask: "maybe I want the ability
 * to upload files from my computer, like Excel files or an Excel template for
 * the agents to use or fill them up."
 *
 * HARD BOUNDARY, recorded here because getting it wrong would be expensive: a
 * file is never a write path. An uploaded sheet that silently changed bids
 * would bypass the critic, the blast-radius guard, the approval gate and the
 * write gate in a single step — four safety layers, defeated by a spreadsheet.
 * Files constrain reasoning and seed assignments. Any change they lead to still
 * goes plan → critic → approval → write gate.
 *
 * Separately: /marketing/ads/bulk owns Amazon bulksheets. This page is about
 * agent inputs and outputs, and must not grow into a second bulk editor.
 */
import { FleetPageShell } from '../_shell/FleetPageShell'
import { PlannedPage } from '../_shell/PlannedPage'
import '../../rules-automation/control-room/control-room.css'
import '../fleet-pages.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <FleetPageShell
      title="Files & data"
      sub="The spreadsheets the fleet reads, and the ones it fills in for you."
    >
      <PlannedPage
        purpose={
          <>
            Give the workers your own numbers. Upload a sheet and a worker can be told to respect
            it — a keyword blocklist, a target ACoS per portfolio, a product priority list, a set
            of competitor ASINs. And when a worker produces something you want in Excel, it lands
            here as a download.
          </>
        }
        contents={[
          'Upload: drag in an .xlsx or .csv, see it parsed and previewed, map the columns once, and keep every version.',
          'Attach a file to a worker, a workflow or an assignment, so it constrains that work and nothing else.',
          'Templates the other way round: a worker fills one in and hands it back, with the run that produced it attached.',
          'A small set of reference tables — your own durable numbers the fleet may read, rather than facts it has to guess.',
        ]}
        needs={
          <>
            All new: file storage, a spreadsheet parser with a column-mapping step, and a typed
            reference-data model. The boundary is the design constraint, not the plumbing — a file
            here can only ever <b>inform</b> a worker. It can never execute, and nothing it
            contains skips the approval gate.
          </>
        }
      />
    </FleetPageShell>
  )
}
