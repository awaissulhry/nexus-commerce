import StockWorkspace from './StockWorkspace'
import AiCopilot from '@/components/AiCopilot'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function StockPage() {
  return (
    <>
      <StockWorkspace />
      {/* ACP.7 — inventory copilot */}
      <AiCopilot
        pageContext={{ route: '/fulfillment/stock' }}
        title="Inventory copilot"
        placeholder="Ask about stock…"
        suggestions={[
          'Where is channel stock drifting?',
          'What should I reorder, and how urgently?',
          'Show stock levels for a SKU',
        ]}
      />
    </>
  )
}
