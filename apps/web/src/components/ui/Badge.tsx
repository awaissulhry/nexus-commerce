import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

type Variant = 'default' | 'success' | 'warning' | 'danger' | 'info'
type Size = 'sm' | 'md'

interface BadgeProps {
  variant?: Variant
  size?: Size
  children: ReactNode
  className?: string
  mono?: boolean
}

const VARIANT: Record<Variant, string> = {
  default: 'bg-slate-100 text-slate-700 border-slate-200',
  success: 'bg-green-50 text-green-700 border-green-200',
  warning: 'bg-amber-50 text-amber-700 border-amber-200',
  danger: 'bg-red-50 text-red-700 border-red-200',
  info: 'bg-blue-50 text-blue-700 border-blue-200',
}

const SIZE: Record<Size, string> = {
  sm: 'text-xs px-1.5 py-0.5',
  md: 'text-sm px-2 py-0.5',
}

export function Badge({
  variant = 'default',
  size = 'sm',
  children,
  className,
  mono,
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 border rounded font-medium',
        VARIANT[variant],
        SIZE[size],
        mono && 'font-mono',
        className
      )}
    >
      {children}
    </span>
  )
}
