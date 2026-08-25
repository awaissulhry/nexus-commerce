'use client'

/**
 * Spinner — ADAPTER over the design system's `Spinner` (Phase 9.3).
 *
 * Was a second implementation, wrapping lucide's `Loader2` with its own size and tone scales
 * while the DS shipped an `@keyframes h10spin` ring. Two spinners is one too many.
 *
 * Only ONE file still imports this — `app/design/page.tsx`, the legacy showcase that 9.7
 * folds into `/design-system`. Every production call site already uses the DS spinner
 * directly (they pass a numeric `size`, which is the DS signature).
 *
 * `tone` and `label` are implemented HERE rather than lifted into the DS. Both have a single
 * caller, on a page scheduled for deletion, and the DS's own answer to "spinner with a word
 * next to it" is composition — `<span><Spinner /> Saving…</span>` — not a prop. Porting them
 * would add permanent API to the system for one doomed showcase.
 */

import { Spinner as DsSpinner } from '@/design-system/primitives/Spinner'

/* The adapter carries its own stylesheet dependency, because the call sites do not.
 * Measured 2026-08-24: `components.css` is imported by 198 files and reaches most routes
 * incidentally, but `primitives.css` by only 46 — `.nds-btn` does not resolve on
 * /design at all. A DS component whose CSS arrives only when some unrelated sibling
 * happens to import it is the same defect class as the Tailwind content-glob gap, one
 * level up. Next dedupes these imports, so paying for them here is free. */
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'

type Size = 'xs' | 'sm' | 'md' | 'lg'
type Tone = 'default' | 'primary' | 'subtle' | 'inherit'

/** The legacy scale was Tailwind classes (w-3, w-3.5, w-4, w-6); the DS takes px. */
const PX: Record<Size, number> = { xs: 12, sm: 14, md: 16, lg: 24 }
const TONE_VAR: Record<Tone, string | undefined> = {
  default: 'var(--nds-text-3)',
  primary: 'var(--nds-primary)',
  subtle: 'var(--nds-text-disabled)',
  inherit: undefined,
}

export function Spinner({
  size = 'md',
  tone = 'default',
  className,
  label,
}: {
  size?: Size
  tone?: Tone
  className?: string
  label?: string
}) {
  const ring = <DsSpinner size={PX[size]} className={className} />
  if (!label) return ring
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: TONE_VAR[tone] }}
    >
      {ring}
      {label}
    </span>
  )
}
