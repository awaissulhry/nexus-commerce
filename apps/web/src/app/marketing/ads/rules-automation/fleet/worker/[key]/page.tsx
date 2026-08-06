/** FX.3 — one worker's own page: pipeline, evidence, findings, limits,
 *  report card, charter, and every run replayable as a story. */
import { WorkerClient } from './WorkerClient'
import '../../../control-room/control-room.css'

export const dynamic = 'force-dynamic'

export default async function Page({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  return (
    <div className="acr">
      <WorkerClient workerKey={key} />
    </div>
  )
}
