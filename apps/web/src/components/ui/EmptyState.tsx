/**
 * EmptyState — ADAPTER over the design system's `EmptyState` (Phase 9.3).
 *
 * The prop NAMES matched the DS one exactly, which made this look like a drop-in re-export.
 * It is not: two of them differ in type, and that is the whole reason this adapter exists.
 *   • `icon` here is a `LucideIcon` COMPONENT; the DS takes an already-rendered `ReactNode`.
 *   • `action` here is a `{ label, href | onClick }` OBJECT; the DS takes a node.
 *
 * Measured across the 56 call sites: 16 pass `href`, 5 pass `onClick`. Both are handled.
 * New code should import from `@/design-system/components/EmptyState` and pass real nodes.
 */

import Link from 'next/link'
import { type LucideIcon } from 'lucide-react'
import { EmptyState as DsEmptyState } from '@/design-system/components/EmptyState'

/* The adapter carries its own stylesheet dependency, because the call sites do not.
 * Measured 2026-08-24: `components.css` is imported by 198 files and reaches most routes
 * incidentally, but `primitives.css` by only 46 — `.nds-btn` does not resolve on
 * /design at all. A DS component whose CSS arrives only when some unrelated sibling
 * happens to import it is the same defect class as the Tailwind content-glob gap, one
 * level up. Next dedupes these imports, so paying for them here is free. */
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import { Button } from '@/design-system/primitives/Button'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  description: string
  action?:
    | { label: string; href: string; onClick?: never }
    | { label: string; onClick: () => void; href?: never }
}

export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  const button = action ? (
    <Button variant="primary" size="sm" onClick={action.onClick}>
      {action.label}
    </Button>
  ) : null

  return (
    <DsEmptyState
      icon={<Icon size={22} aria-hidden />}
      title={title}
      description={description}
      action={action?.href ? <Link href={action.href}>{button}</Link> : button}
    />
  )
}
