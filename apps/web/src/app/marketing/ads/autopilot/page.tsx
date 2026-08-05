/** AI Control — two views on one rail entry (ADX N4).
 *  Autonomy: what is allowed to change the account without asking.
 *  Mission Control (P0): the operational object-graph canvas.
 *  AutopilotControlRoom is still preserved for reuse but is NOT mounted; its SSE/decision-feed
 *  logic returns in a later phase.
 *
 *  ACR.1.6 — the Autonomy half of this page is now superseded by the Control Room
 *  (/marketing/ads/rules-automation/control-room), which shows the same rules on the same
 *  endpoint with the same four-notch dial, plus the engines the autonomy board never listed.
 *  This page and its rail entry are retired once that surface has been used in anger and its
 *  UI pass is done — replacing a working page before its replacement is proven is the wrong
 *  order, and keeping both lets them be compared. */
import { AiControlTabs } from './AiControlTabs'

export const dynamic = 'force-dynamic'

export default function Page() {
  return <AiControlTabs />
}
