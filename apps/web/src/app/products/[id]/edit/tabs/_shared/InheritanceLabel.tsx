'use client'

/**
 * PIM B.2 — Inheritance status chip.
 *
 * Renders a small chip indicating the current inheritance state of a
 * field on a channel tab. Three modes:
 *   - inherited:  gray ↺ chip — "inherited from Global"
 *   - override:   amber ⚠ chip — "overridden on <marketplace>"
 *   - synthesized: blue ✻ chip — "from legacy column" (A.4 compat)
 *
 * Compact form (no label) suits dense per-field layouts; expanded
 * form (with explanatory text) is for the inheritance panel header.
 */

import { ChevronsRight, RotateCcw, AlertTriangle, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

export type InheritanceMode = 'inherited' | 'override' | 'synthesized'

interface Props {
  mode: InheritanceMode
  /** Display name for "where the value came from" (e.g. "Global",
   *  "Variant master", "legacy column"). Shown in expanded form. */
  sourceLabel?: string
  /** Display name for "where the value is being applied" (e.g.
   *  "Amazon IT"). Used in override mode. */
  targetLabel?: string
  /** Compact mode hides the explanatory text and shrinks padding. */
  compact?: boolean
  className?: string
}

export default function InheritanceLabel({
  mode,
  sourceLabel,
  targetLabel,
  compact = false,
  className,
}: Props) {
  const { Icon, text, classes } = describe(mode, sourceLabel, targetLabel)

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded font-medium',
        compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs',
        classes,
        className,
      )}
      aria-label={text}
    >
      <Icon className={compact ? 'w-2.5 h-2.5' : 'w-3 h-3'} />
      {!compact && <span>{text}</span>}
    </span>
  )
}

function describe(
  mode: InheritanceMode,
  source?: string,
  target?: string,
): {
  Icon: typeof ChevronsRight
  text: string
  classes: string
} {
  switch (mode) {
    case 'inherited':
      return {
        Icon: RotateCcw,
        text: source ? `inherited from ${source}` : 'inherited',
        classes:
          'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400 ring-1 ring-zinc-200 dark:ring-zinc-700',
      }
    case 'override':
      return {
        Icon: AlertTriangle,
        text: target ? `overridden on ${target}` : 'overridden',
        classes:
          'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300 ring-1 ring-amber-200 dark:ring-amber-800',
      }
    case 'synthesized':
      return {
        Icon: Sparkles,
        text: source ? `from ${source}` : 'from legacy column',
        classes:
          'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300 ring-1 ring-blue-200 dark:ring-blue-800',
      }
  }
}
