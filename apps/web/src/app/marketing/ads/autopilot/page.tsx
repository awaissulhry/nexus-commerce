/** Ads Mission Control (P0) — operational object-graph canvas.
 *  Supersedes the AutopilotControlRoom render here; that file is preserved for
 *  reuse (its SSE/decision-feed logic returns in a later phase). */
import { MissionControlClient } from './MissionControlClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return <MissionControlClient />
}
