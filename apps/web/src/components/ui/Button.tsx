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

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-blue-600 hover:bg-blue-700 text-white border-blue-600 dark:bg-blue-500 dark:hover:bg-blue-600 dark:border-blue-500',
  secondary:
    'bg-white hover:bg-slate-50 text-slate-900 border-slate-200 dark:bg-slate-900 dark:hover:bg-slate-800 dark:text-slate-100 dark:border-slate-700',
  ghost:
    'bg-transparent hover:bg-slate-100 text-slate-700 border-transparent dark:hover:bg-slate-800 dark:text-slate-300',
  danger:
    'bg-red-600 hover:bg-red-700 text-white border-red-600 dark:bg-red-500 dark:hover:bg-red-600 dark:border-red-500',
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
          'inline-flex items-center justify-center font-medium border rounded-md transition-colors',
          // U.13 — focus-visible (not focus) so keyboard users get
          // the ring but mouse-clickers don't get a sticky outline
          // after every click. Matches WAI-ARIA 1.3 guidance.
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900',
          'disabled:opacity-50 disabled:cursor-not-allowed',
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
