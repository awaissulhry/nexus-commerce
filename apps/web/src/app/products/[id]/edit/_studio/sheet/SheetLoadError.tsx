'use client'

import { AlertCircle } from 'lucide-react'
import { EmptyState } from '@/design-system/components'
import { Button } from '@/design-system/primitives'

export function SheetLoadError({ label, unavailable = false, message, onRetry }: {
  label: string; unavailable?: boolean; message?: string | null; onRetry: () => void
}) {
  return <div role="alert">
    <EmptyState icon={<AlertCircle size={24} aria-hidden />} title={`Could not load ${label}`} description={message ?? (unavailable
      ? 'This information is currently unavailable. Try again or choose another marketplace.'
      : 'Nexus could not finish loading this information. Try again in a moment.')}
      action={<Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button>} />
  </div>
}
