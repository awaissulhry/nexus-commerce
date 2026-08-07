/** FX.3 — one worker's own page: pipeline, evidence, findings, limits,
 *  report card, charter, and every run replayable as a story. */
import { WorkerClient } from './WorkerClient'
import '../../../control-room/control-room.css'
// SB.W — WorkerClient now renders the shared ConfirmSpend dialog, whose classes
// (.acr-pg-confirmwrap / .acr-pg-confirm) live ONLY in fleet-pages.css. This
// legacy route is still reachable — SB.7 deliberately did not redirect
// /marketing/ads/rules-automation/fleet/* — so without this line the dialog
// renders completely unstyled here while looking correct on /fleet/workers/[key].
import '@/app/fleet/fleet-pages.css'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  return (
    <div className="acr">
      <WorkerClient workerKey={key} />
    </div>
  )
}
