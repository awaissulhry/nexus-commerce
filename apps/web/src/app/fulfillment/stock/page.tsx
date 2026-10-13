import { ToastProvider } from '@/design-system/components/Toast'
import StockWorkspace from './StockWorkspace'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function StockPage() {
  // ACP.7b — copilot is mounted globally in the root layout (CopilotMount).
  // The DS toast provider: the FBM cell (StockSplit) says why a save was refused.
  return (
    <ToastProvider>
      <StockWorkspace />
    </ToastProvider>
  )
}
