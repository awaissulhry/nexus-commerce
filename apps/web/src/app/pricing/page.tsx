import PricingMatrixClient from './PricingMatrixClient'

export const dynamic = 'force-dynamic'

export default function PricingPage() {
  // ACP.7b — copilot is mounted globally in the root layout (CopilotMount).
  return <PricingMatrixClient />
}
