import { Truck } from 'lucide-react'
import ComingSoonPage from '@/components/layout/ComingSoonPage'

export const dynamic = 'force-dynamic'

export default function CarriersPage() {
  return (
    <ComingSoonPage
      title="Carriers"
      description="Manage shipping integrations"
      icon={Truck}
      emptyDescription="Connect DHL, UPS, FedEx, BRT, GLS, and Poste Italiane for label generation and rate shopping. Ships in Phase 5."
    />
  )
}
