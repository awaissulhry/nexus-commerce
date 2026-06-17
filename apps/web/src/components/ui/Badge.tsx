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

// P1 — solid soft/line/strong status tones; all auto-flip in dark + AA.
const VARIANT: Record<Variant, string> = {
  default: 'bg-sunken text-secondary border-default',
  success: 'bg-success-soft text-success-strong border-success-line',
  warning: 'bg-warning-soft text-warning-strong border-warning-line',
  danger: 'bg-danger-soft text-danger-strong border-danger-line',
  info: 'bg-info-soft text-info-strong border-info-line',
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
