'use client'

import { AlertCircle } from 'lucide-react'
import { EmptyState } from '@/design-system/components'
import { Button } from '@/design-system/primitives'

export function SheetLoadError({ label, unavailable = false, onRetry }: {
  label: string; unavailable?: boolean; onRetry: () => void
}) {
  return <div role="alert">
    <EmptyState icon={<AlertCircle size={24} aria-hidden />} title={`Could not load ${label}`} description={unavailable
      ? 'This information is currently unavailable. Try again or choose another marketplace.'
      : 'Check your connection and try again. If this continues, check your access to this product.'}
      action={<Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button>} />
  </div>
}
