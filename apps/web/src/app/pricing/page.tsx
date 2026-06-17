import PricingMatrixClient from './PricingMatrixClient'
import AiCopilot from '@/components/AiCopilot'

export const dynamic = 'force-dynamic'

export default function PricingPage() {
  return (
    <>
      <PricingMatrixClient />
      {/* ACP.7 — pricing copilot */}
      <AiCopilot
        pageContext={{ route: '/pricing' }}
        title="Pricing copilot"
        placeholder="Ask about pricing…"
        suggestions={[
          'Which products are priced below cost or floor?',
          'What’s the price spread across channels for a SKU?',
          'Propose a price change for a SKU',
        ]}
      />
    </>
  )
}
