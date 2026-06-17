'use client'

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

// P1 — semantic tokens. secondary/ghost auto-flip in dark via the
// surface/text tokens (no dark: variants needed); the solid primary/
// danger keep a dark step for a brighter fill on dark canvas.
const VARIANT: Record<Variant, string> = {
  primary:
    'bg-info-600 hover:bg-info-700 text-white border-info-600 dark:bg-info-500 dark:hover:bg-info-600 dark:border-info-500',
  secondary:
    'bg-card hover:bg-sunken dark:hover:bg-raised text-primary border-default',
  ghost:
    'bg-transparent hover:bg-sunken dark:hover:bg-raised text-secondary hover:text-primary border-transparent',
  danger:
    'bg-danger-600 hover:bg-danger-700 text-white border-danger-600 dark:bg-danger-500 dark:hover:bg-danger-600 dark:border-danger-500',
}

const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-base gap-1',
  md: 'h-8 px-3 text-md gap-1.5',
  lg: 'h-10 px-4 text-lg gap-2',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          'inline-flex items-center justify-center font-label border rounded-md transition-colors',
          // U.13 — focus-visible (not focus) so keyboard users get
          // the ring but mouse-clickers don't get a sticky outline
          // after every click. Matches WAI-ARIA 1.3 guidance.
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-info-500/50 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900',
          // Disabled state — keep the button legible at 4.5:1 contrast
          // regardless of the parent background (white tray, dark
          // slate-900 bulk bar, rose/emerald confirmation tray, …).
          // Previously used `disabled:opacity-50`, which blends every
          // pixel with the parent and turns a white-on-dark Apply
          // button into a near-invisible block of mid-grey.
          // `disabled:` overrides every variant/className color so
          // disabled actions read as the same muted state app-wide.
          'disabled:cursor-not-allowed disabled:!bg-slate-100 disabled:!text-slate-400 disabled:!border-slate-200',
          'disabled:dark:!bg-slate-800 disabled:dark:!text-slate-500 disabled:dark:!border-slate-700',
          VARIANT[variant],
          SIZE[size],
          className
        )}
        {...props}
      >
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : icon}
        {children}
      </button>
    )
  }
)

Button.displayName = 'Button'
