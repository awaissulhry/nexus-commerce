import { RefreshCw } from 'lucide-react'
import ComingSoonPage from '@/components/layout/ComingSoonPage'

export const dynamic = 'force-dynamic'

export default function SmartReplenishmentPage() {
  return (
    <ComingSoonPage
      title="Smart Replenishment"
      description="Reorder forecasts based on velocity and lead times"
      icon={RefreshCw}
      emptyDescription="AI-driven reorder recommendations using sales velocity, supplier lead times, and seasonality. Ships in Phase 5 once we have 30 days of order history."
    />
  )
}
