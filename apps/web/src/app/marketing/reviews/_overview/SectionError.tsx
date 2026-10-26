'use client'

/**
 * Reviews Overview — one card's failed read: its own danger Banner with the API's words and "Try again", in place of
 * the card's numbers (never zeros, never an empty state).
 */
import { Banner } from '@/design-system/components'
import { Button } from '@/design-system/primitives'

export function SectionError({ error, onRetry, busy }: { error: string; onRetry: () => void; busy?: boolean }) {
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
