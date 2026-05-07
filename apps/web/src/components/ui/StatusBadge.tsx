'use client'

/**
 * U.2 — StatusBadge primitive.
 *
 * Wrapper over <Badge> that maps a status string to the right tone
 * via STATUS_VARIANT (lib/theme). Lets row renderers and grid cells
 * write `<StatusBadge status={p.status} />` instead of recomputing
 * the variant per call site.
 *
 * Why a separate primitive:
 *   - 7+ places across the catalog workflow render the same status
 *     pill with the same status→variant mapping; some duplicate the
 *     STATUS_VARIANT lookup, some hard-code the variant
 *   - Future status additions only need the lib/theme entry; this
 *     surfaces them everywhere
 *
 * The display string defaults to the raw status (ACTIVE, DRAFT,
 * INACTIVE, LIVE, etc.). Pass `label` to override (e.g. localised
 * labels in U.15).
 */

import { Badge } from './Badge'
import { STATUS_VARIANT } from '@/lib/theme'

interface StatusBadgeProps {
  status: string
  /** Override the displayed text. Defaults to the raw status string. */
  label?: string
  size?: 'sm' | 'md'
  className?: string
}

export function StatusBadge({ status, label, size = 'sm', className }: StatusBadgeProps) {
  const variant = STATUS_VARIANT[status] ?? 'default'
  return (
    <Badge variant={variant} size={size} className={className}>
      {label ?? status}
    </Badge>
  )
}
