/**
 * Map — the operational object-graph canvas.
 *
 * ACR.1.6 — this route was "AI Control": Mission Control plus an autonomy board, behind its own
 * rail entry. The board half is now the Control Room's Rules section, on the same endpoint with
 * the same four-notch dial and the same graduation ceilings, beside the engines that board never
 * listed. Keeping two surfaces that edit the same rules is how they drift.
 *
 * The canvas is NOT superseded — it is a view of the account's shape, which nothing else gives.
 * So it keeps this route and is reached from the Control Room's Today tab, per the plan: it is a
 * map, not a control surface, and the rail is kept short on purpose.
 *
 * AutopilotControlRoom stays unmounted in this directory for its SSE/decision-feed logic.
 */
import { MissionControlClient } from './MissionControlClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return <MissionControlClient />
}
