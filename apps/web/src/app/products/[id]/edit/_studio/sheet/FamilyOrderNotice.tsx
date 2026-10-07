'use client'

/**
 * The Information page's one notice when the family order could not be read (`useFamilyRank`). The Shared product page
 * and every market page render this same component, so the sentence and the retry are the same everywhere.
 */
import { Banner } from '@/design-system/components'
import { Button } from '@/design-system/primitives'

export function FamilyOrderNotice({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (!error) return null
  return (
    <Banner tone="warning" title="The variation order could not be read" action={<Button size="sm" onClick={onRetry}>Try again</Button>}>
      {error} — until it is read, the rows may not follow the variation order.
    </Banner>
  )
}
