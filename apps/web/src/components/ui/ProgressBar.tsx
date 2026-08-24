'use client'

/**
 * ProgressBar — ADAPTER over the design system's `ProgressBar` (Phase 9.3).
 *
 * The platform had THREE bars: this one, the DS one, and a hand-rolled `{ pct }` copy inside
 * `ReconciliationClient.tsx`. The track and fill are now the DS's in every case.
 *
 * Only `app/design/page.tsx` still imports this file. The label row (`label`, `showCount`,
 * `showPercent`) stays here as composition rather than becoming DS props: the DS bar is the
 * bar, and a caption above it is a caller's layout decision.
 */

import { ProgressBar as DsProgressBar } from '@/design-system/components/ProgressBar'

/* The adapter carries its own stylesheet dependency, because the call sites do not.
 * Measured 2026-08-24: `components.css` is imported by 198 files and reaches most routes
 * incidentally, but `primitives.css` by only 46 — `.h10-ds-btn` does not resolve on
 * /design at all. A DS component whose CSS arrives only when some unrelated sibling
 * happens to import it is the same defect class as the Tailwind content-glob gap, one
 * level up. Next dedupes these imports, so paying for them here is free. */
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'

export function ProgressBar({
  value = 0,
  max = 100,
  indeterminate,
  label,
  showCount,
  showPercent,
  size = 'md',
  className,
}: {
  value?: number
  max?: number
  indeterminate?: boolean
  label?: string
  showCount?: boolean
  showPercent?: boolean
  tone?: 'default' | 'success' | 'warning' | 'danger'
  size?: 'sm' | 'md'
  className?: string
}) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  const caption = showPercent ? `${Math.round(pct)}%` : showCount ? `${value} / ${max}` : null
  return (
    <div className={className}>
      {(label || caption) && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
            marginBottom: 4,
            fontSize: 12,
            color: 'var(--h10-text-2)',
          }}
        >
          {label && <span>{label}</span>}
          {caption && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{caption}</span>}
        </div>
      )}
      <DsProgressBar value={pct} indeterminate={indeterminate} height={size === 'sm' ? 4 : 6} />
    </div>
  )
}
