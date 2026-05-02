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
  primary: 'bg-blue-600 hover:bg-blue-700 text-white border-blue-600',
  secondary: 'bg-white hover:bg-slate-50 text-slate-900 border-slate-200',
  ghost: 'bg-transparent hover:bg-slate-100 text-slate-700 border-transparent',
  danger: 'bg-red-600 hover:bg-red-700 text-white border-red-600',
}

const SIZE: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-[12px] gap-1',
  md: 'h-8 px-3 text-[13px] gap-1.5',
  lg: 'h-10 px-4 text-[14px] gap-2',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'md', loading, icon, children, className, disabled, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          'inline-flex items-center justify-center font-medium border rounded-md transition-colors',
          'focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:ring-offset-1',
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
