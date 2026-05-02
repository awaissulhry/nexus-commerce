import { PackageOpen } from 'lucide-react'
import ComingSoonPage from '@/components/layout/ComingSoonPage'

export const dynamic = 'force-dynamic'

export default function OutboundShipmentsPage() {
  return (
    <ComingSoonPage
      title="Outbound Shipments"
      description="Fulfill orders from your own warehouse"
      icon={PackageOpen}
      emptyDescription="Pick, pack, and ship orders that don't go through Amazon FBA. Wave-picking, label printing, and tracking sync ship in Phase 5."
    />
  )
}
