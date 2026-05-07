'use client'

/**
 * Spinner — wraps Loader2 with consistent size + tone tokens.
 *
 * Pages re-implement Loader2 with one-off width/height + colour
 * classes; this collapses them to a single component. Use sparingly
 * — for multi-second waits, prefer a Skeleton over a spinner so the
 * user sees the page shape rather than a generic "loading" indicator.
 */

import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

type Size = 'xs' | 'sm' | 'md' | 'lg'
type Tone = 'default' | 'primary' | 'subtle' | 'inherit'

const SIZE: Record<Size, string> = {
  xs: 'w-3 h-3',
  sm: 'w-3.5 h-3.5',
  md: 'w-4 h-4',
  lg: 'w-6 h-6',
}

const TONE: Record<Tone, string> = {
  default: 'text-slate-500',
  primary: 'text-blue-600',
  subtle: 'text-slate-300',
  inherit: '',
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
  /** Visible label rendered to the right of the spinner. Useful for
   *  inline status: <Spinner label="Saving…" />. */
  label?: string
}) {
  if (label) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-base',
          TONE[tone],
          className,
        )}
      >
        <Loader2 className={cn(SIZE[size], 'animate-spin')} />
        {label}
      </span>
    )
  }
  return (
    <Loader2
      className={cn(SIZE[size], 'animate-spin', TONE[tone], className)}
    />
  )
}
