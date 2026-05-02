import { type LucideIcon } from 'lucide-react'
import PageHeader from './PageHeader'
import { EmptyState } from '@/components/ui/EmptyState'

interface Props {
  title: string
  description: string
  icon: LucideIcon
  emptyTitle?: string
  emptyDescription: string
}

/**
 * Lightweight scaffold for routes that exist in the nav but don't have
 * functionality yet. Renders the standard PageHeader + a single
 * EmptyState card.
 */
export default function ComingSoonPage({
  title,
  description,
  icon,
  emptyTitle,
  emptyDescription,
}: Props) {
  return (
    <div className="space-y-5">
      <PageHeader title={title} description={description} />
      <EmptyState
        icon={icon}
        title={emptyTitle ?? 'Coming soon'}
        description={emptyDescription}
      />
    </div>
  )
}
