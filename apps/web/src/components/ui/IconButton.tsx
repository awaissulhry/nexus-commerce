'use client'

/**
 * U.2 — IconButton primitive.
 *
 * 42 hand-rolled `h-N w-N inline-flex items-center justify-center`
 * patterns across the codebase that re-implement the same icon-only
 * button. This component standardises them with consistent focus
 * rings, disabled states, and accessible aria-label requirement.
 *
 * Always pass `aria-label` — icon-only buttons have no text content
 * for screen readers. The TypeScript type makes it required.
 *
 * Usage:
 *   <IconButton aria-label="Delete view" onClick={onDelete}>
 *     <Trash2 className="w-3 h-3" />
 *   </IconButton>
 *
 *   <IconButton
 *     aria-label="More actions"
 *     variant="ghost"
 *     size="sm"
 *     tone="danger"
 *   >
 *     <X className="w-3 h-3" />
 *   </IconButton>
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

type Variant = 'solid' | 'ghost' | 'outline'
type Size = 'xs' | 'sm' | 'md' | 'lg'
type Tone = 'neutral' | 'info' | 'danger' | 'warning'

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  /** REQUIRED — icon-only buttons need a screen-reader name. */
  'aria-label': string
  variant?: Variant
  size?: Size
  tone?: Tone
  children: ReactNode
}

// Per-tone colour mappings. Each row is a (text, hover-bg) pair.
// Tone is independent of variant — variant controls density (solid
// background vs ghost vs outline), tone controls the colour family.
// P1 — neutral repointed to semantic tokens (auto-dark); coloured
// tones use the soft/line/strong status set so their hover/border
// flip cleanly in dark too.
const TONE_GHOST: Record<Tone, string> = {
  neutral: 'text-tertiary hover:text-primary hover:bg-sunken',
  info:    'text-info-strong hover:bg-info-soft',
  danger:  'text-danger-strong hover:bg-danger-soft',
  warning: 'text-warning-strong hover:bg-warning-soft',
}

const TONE_SOLID: Record<Tone, string> = {
  neutral: 'bg-slate-700 hover:bg-slate-800 text-white dark:bg-slate-600 dark:hover:bg-slate-500',
  info:    'bg-info-600 hover:bg-info-700 text-white',
  danger:  'bg-danger-600 hover:bg-danger-700 text-white',
  warning: 'bg-warning-500 hover:bg-warning-600 text-white',
}

const TONE_OUTLINE: Record<Tone, string> = {
  neutral: 'border border-default text-secondary hover:bg-sunken',
  info:    'border border-info-line text-info-strong hover:bg-info-soft',
  danger:  'border border-danger-line text-danger-strong hover:bg-danger-soft',
  warning: 'border border-warning-line text-warning-strong hover:bg-warning-soft',
}

// Size = the square. Icons inside should be ~70% of the size.
const SIZE: Record<Size, string> = {
  xs: 'h-5 w-5',
  sm: 'h-6 w-6',
  md: 'h-7 w-7',
  lg: 'h-8 w-8',
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  (
    { variant = 'ghost', size = 'md', tone = 'neutral', children, className, disabled, ...props },
    ref,
  ) => {
    const toneClass =
      variant === 'solid'
        ? TONE_SOLID[tone]
        : variant === 'outline'
          ? TONE_OUTLINE[tone]
          : TONE_GHOST[tone]
    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        className={cn(
          'inline-flex items-center justify-center rounded-md transition-colors duration-fast',
          'focus:outline-none focus:ring-2 focus:ring-info-500/30 focus:ring-offset-1',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          SIZE[size],
          toneClass,
          className,
        )}
        {...props}
      >
        {children}
      </button>
    )
  },
)

IconButton.displayName = 'IconButton'
