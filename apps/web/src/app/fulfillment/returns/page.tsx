import { Undo2 } from 'lucide-react'
import ComingSoonPage from '@/components/layout/ComingSoonPage'

export const dynamic = 'force-dynamic'

export default function ReturnsPage() {
  return (
    <ComingSoonPage
      title="Returns"
      description="Process customer returns and refunds"
      icon={Undo2}
      emptyDescription="Cross-channel return management with auto-refund, restock-to-channel routing, and condition grading. Ships in Phase 5."
    />
  )
}
