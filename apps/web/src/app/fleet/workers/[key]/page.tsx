/**
 * NAF.SB.7 — one worker's own page, inside the fleet shell.
 *
 * The component still lives under marketing/ads/rules-automation/fleet/worker/
 * because a parallel session owns it. Without this route, clicking a worker in
 * the registry would throw the operator out of the fleet shell and into the ads
 * console — different rail, different chrome, same task. That is a worse defect
 * than the duplication, so the route renders their component from where it sits.
 *
 * The old URL still works and is unchanged. SB.2 folds both into one when that
 * session lands.
 */
import { WorkerClient } from '@/app/marketing/ads/rules-automation/fleet/worker/[key]/WorkerClient'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../../fleet-pages.css'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  return (
    <div className="acr">
      <WorkerClient workerKey={key} />
    </div>
  )
}
