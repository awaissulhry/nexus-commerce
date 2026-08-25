/**
 * Card — ADAPTER over the design system's `Card` (Phase 9.3).
 *
 * Was a second implementation of "bordered surface with an optional header": its own Tailwind
 * chrome, its own header layout, its own padding rule. 145 files and 485 call sites used it,
 * which is exactly why it could not be left to drift from the DS one.
 *
 * The legacy API is kept verbatim:
 *   • `title`       → the DS's `header`
 *   • `description` → lifted INTO the DS (105 call sites wanted a sub-line and this duplicate
 *                     was the only way to get one)
 *   • `action`      → the DS's `headerAction`
 *   • `noPadding`   → the DS's `padded={false}`, which now also reaches the body of a HEADED
 *                     card — previously impossible, and the reason 17 charts kept this file
 *
 * New code should import from `@/design-system/components/Card`.
 */

import { type ReactNode } from 'react'
import { Card as DsCard } from '@/design-system/components/Card'

/* The adapter carries its own stylesheet dependency, because the call sites do not.
 * Measured 2026-08-24: `components.css` is imported by 198 files and reaches most routes
 * incidentally, but `primitives.css` by only 46 — `.nds-btn` does not resolve on
 * /design at all. A DS component whose CSS arrives only when some unrelated sibling
 * happens to import it is the same defect class as the Tailwind content-glob gap, one
 * level up. Next dedupes these imports, so paying for them here is free. */
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'

interface CardProps {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  noPadding?: boolean
}

export function Card({ title, description, action, children, className, noPadding }: CardProps) {
  return (
    <DsCard
      header={title}
      description={title != null ? description : undefined}
      headerAction={action}
      padded={!noPadding}
      className={className}
    >
      {children}
    </DsCard>
  )
}
