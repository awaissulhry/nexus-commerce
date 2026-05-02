import { Image as ImageIcon } from 'lucide-react'
import ComingSoonPage from '@/components/layout/ComingSoonPage'

export const dynamic = 'force-dynamic'

export default function ContentHubPage() {
  return (
    <ComingSoonPage
      title="Content Hub"
      description="Images, videos, A+ content, and brand stories"
      icon={ImageIcon}
      emptyDescription="Centralized media library with per-channel image variants, A+ Content templates, and video upload. Ships in Phase 5."
    />
  )
}
