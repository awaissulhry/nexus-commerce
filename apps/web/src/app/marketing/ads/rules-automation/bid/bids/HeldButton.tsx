'use client'

/**
 * A DS Button that may be HELD: never `disabled` (a disabled button takes no focus, so its reason is never heard —
 * scripts/check-silent-disabled.mjs). Held, it keeps its focus, says why on hover and focus (a portal tooltip) and to a
 * screen reader (`aria-description`), and a click does nothing. The same shape as the DS review dialog's held Save.
 */
import type { ReactNode } from 'react'
import { Button, Tooltip, type ButtonProps } from '@/design-system/primitives'

export function HeldButton({ held, onClick, children, ...rest }: Omit<ButtonProps, 'disabled'> & { held: string | null; children: ReactNode }) {
  const button = (
    <Button
      {...rest}
      aria-disabled={held ? true : undefined}
      aria-description={held ?? undefined}
      onClick={held ? undefined : onClick}
    >
      {children}
    </Button>
  )
  return held ? <Tooltip label={held} portal>{button}</Tooltip> : button
}
