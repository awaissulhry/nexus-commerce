import { type ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface CardProps {
  title?: ReactNode
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  noPadding?: boolean
}

export function Card({ title, description, action, children, className, noPadding }: CardProps) {
  return (
    <div className={cn('bg-white border border-slate-200 rounded-lg', className)}>
      {(title || description || action) && (
        <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-slate-200">
          <div className="min-w-0">
            {title && (
              <h2 className="text-[13px] font-semibold text-slate-900">{title}</h2>
            )}
            {description && (
              <p className="text-[11px] text-slate-500 mt-0.5">{description}</p>
            )}
          </div>
          {action && <div className="flex-shrink-0">{action}</div>}
        </div>
      )}
      <div className={cn(noPadding ? '' : 'p-4')}>{children}</div>
    </div>
  )
}
