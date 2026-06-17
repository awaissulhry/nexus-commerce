import OrdersWorkspace from './OrdersWorkspace'
import AiCopilot from '@/components/AiCopilot'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function OrdersPage() {
  return (
    <>
      <OrdersWorkspace />
      {/* ACP.7 — orders copilot */}
      <AiCopilot
        pageContext={{ route: '/orders' }}
        title="Orders copilot"
        placeholder="Ask about orders…"
        suggestions={[
          'How many orders this week, and from which marketplaces?',
          'Find recent orders from a buyer',
          'Draft a friendly reply to a customer about their order',
        ]}
      />
    </>
  )
}
