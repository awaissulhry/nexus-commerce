import { PackageCheck } from 'lucide-react'
import ComingSoonPage from '@/components/layout/ComingSoonPage'

export const dynamic = 'force-dynamic'

export default function InboundShipmentsPage() {
  return (
    <ComingSoonPage
      title="Inbound Shipments"
      description="Send stock into FBA or your own warehouse"
      icon={PackageCheck}
      emptyDescription="Create and track shipments to Amazon FBA centers, your own warehouse, or 3PL partners. Carrier label generation and ASN integration ship in Phase 5."
    />
  )
}
