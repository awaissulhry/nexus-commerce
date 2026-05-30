// RX.4 — Returns Automation. Guardrailed, diff-then-apply: the engine
// previews which REQUESTED returns are auto-approvable under their
// resolved policy (autoApprove + in-window + under high-value), and the
// operator applies only what they confirm. Refunds are never automated.

export const dynamic = 'force-dynamic'

import AutomationClient from './AutomationClient'

export default function ReturnsAutomationPage() {
  return <AutomationClient />
}
