'use client'

/**
 * Reviews › Settings — one section's failed read: a danger Banner with the API's words and "Try again", in place of
 * the section's content (never zeros, never an empty list).
 */
import { Banner } from '@/design-system/components'
import { Button } from '@/design-system/primitives'

export function ReadFailed({ error, onRetry, busy }: { error: string; onRetry: () => void; busy?: boolean }) {
  return (
    <Banner
      tone="danger"
      action={
        <Button size="sm" onClick={onRetry} heldReason={busy ? 'Reading again…' : null}>
          Try again
        </Button>
      }
    >
      {error}
    </Banner>
  )
}
