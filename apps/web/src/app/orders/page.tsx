import OrdersWorkspace from './OrdersWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function OrdersPage() {
  // ACP.7b — copilot is mounted globally in the root layout (CopilotMount).
  return <OrdersWorkspace />
}
