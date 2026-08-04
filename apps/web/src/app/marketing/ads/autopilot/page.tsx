/** AI Control — two views on one rail entry (ADX N4).
 *  Autonomy: what is allowed to change the account without asking.
 *  Mission Control (P0): the operational object-graph canvas.
 *  AutopilotControlRoom is still preserved for reuse; its SSE/decision-feed logic
 *  returns in a later phase. */
import { AiControlTabs } from './AiControlTabs'

export const dynamic = 'force-dynamic'

export default function Page() {
  return <AiControlTabs />
}
